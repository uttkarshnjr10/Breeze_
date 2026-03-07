"""
Breeze TripGraph — LocationResolver.
Converts raw user input into a resolved TransitNode.
5-step resolution pipeline with census village fallback.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from src.database import get_pool
from src.graph.graph_store import GraphStore, _haversine_km
from src.models.transit import TransitNode
from src.metrics import routing_metrics

logger = logging.getLogger(__name__)

# Maximum distance (km) to snap GPS coordinates to a transit node
MAX_SNAP_RADIUS_KM = 3.0

# Minimum similarity score for fuzzy village name matching
MIN_VILLAGE_SIMILARITY = 0.4


@dataclass
class ResolutionResult:
    """Result of a location resolution attempt."""

    node: TransitNode | None = None
    nearest_node: TransitNode | None = None  # For villages: nearest transit node
    village_lat: float | None = None  # Actual village lat
    village_lng: float | None = None  # Actual village lng
    gap_km: float = 0.0  # Distance from nearest node to actual destination
    warnings: list[str] | None = None
    fallback_used: str | None = None  # Which fallback step was used


class LocationResolver:
    """
    Resolves raw user input into a TransitNode.
    Pipeline runs steps 1-5 in order, stopping at first success.
    """

    def __init__(self, graph_store: GraphStore) -> None:
        self._graph_store = graph_store

    async def resolve(
        self,
        lat: float | None = None,
        lng: float | None = None,
        label: str = "",
        node_id: str | None = None,
    ) -> ResolutionResult:
        """
        Resolve a location to a TransitNode.

        Steps:
          1. Direct node_id match
          2. GPS-to-node (lat/lng within 3km)
          3. Place name geocoding (stub — would call Google Maps API)
          4. Census village database (pg_trgm fuzzy match)
          5. Fuzzy fallback (nearest node with warning)
        """
        warnings: list[str] = []

        # ── Step 1: Direct node_id match ──────────────────────
        if node_id:
            node = self._graph_store.get_node(node_id)
            if node:
                logger.info("Location resolved via direct node_id: %s", node_id)
                return ResolutionResult(node=node)
            warnings.append(f"Node ID '{node_id}' not found in transit graph.")

        # ── Step 2: GPS-to-node ───────────────────────────────
        if lat is not None and lng is not None:
            nearest = self._graph_store.get_nearest_node(lat, lng)
            if nearest:
                distance = _haversine_km(lat, lng, nearest.lat, nearest.lng)
                if distance <= MAX_SNAP_RADIUS_KM:
                    logger.info(
                        "Location resolved via GPS snap: (%f, %f) → %s (%.1fkm)",
                        lat, lng, nearest.id, distance,
                    )
                    return ResolutionResult(node=nearest)
                # > 3km — proceed to further steps but keep this as fallback
                logger.info(
                    "Nearest node %s is %.1fkm away (> 3km), trying further resolution",
                    nearest.id, distance,
                )

        # ── Step 3: Place name geocoding ──────────────────────
        if label:
            # In production, this would call Google Maps Geocoding API
            # For now, try matching label against known node names
            resolved = self._try_name_match(label)
            if resolved:
                logger.info("Location resolved via name match: '%s' → %s", label, resolved.id)
                return ResolutionResult(node=resolved)

        # ── Step 4: Census village database ───────────────────
        if label:
            village_result = await self._try_census_village(label)
            if village_result:
                routing_metrics.location_fallback_total.add(
                    1, {"fallback_type": "village_db"},
                )
                logger.info(
                    "Location resolved via census village: '%s' → nearest node %s (%.1fkm gap)",
                    label,
                    village_result.nearest_node.id if village_result.nearest_node else "None",
                    village_result.gap_km,
                )
                village_result.fallback_used = "village_db"
                village_result.warnings = [
                    "Destination resolved approximately. "
                    "Last-mile route may be unconfirmed."
                ]
                return village_result

        # ── Step 5: Fuzzy fallback ────────────────────────────
        if lat is not None and lng is not None:
            nearest = self._graph_store.get_nearest_node(lat, lng)
            if nearest:
                distance = _haversine_km(lat, lng, nearest.lat, nearest.lng)
                routing_metrics.location_fallback_total.add(
                    1, {"fallback_type": "nearest_node"},
                )
                logger.warning(
                    "Location resolved via fuzzy fallback: (%f, %f) → %s (%.1fkm)",
                    lat, lng, nearest.id, distance,
                )
                return ResolutionResult(
                    node=nearest,
                    nearest_node=nearest,
                    village_lat=lat,
                    village_lng=lng,
                    gap_km=distance,
                    warnings=[
                        "Destination resolved approximately. "
                        "Last-mile route may be unconfirmed."
                    ],
                    fallback_used="nearest_node",
                )

        # ── No resolution possible ────────────────────────────
        logger.error("Location resolution failed for label='%s', lat=%s, lng=%s", label, lat, lng)
        return ResolutionResult(
            warnings=["Could not resolve location. Please provide more specific input."],
        )

    def _try_name_match(self, label: str) -> TransitNode | None:
        """Try to match a label against known transit node names."""
        label_lower = label.lower().strip()
        for node in self._graph_store.get_all_nodes():
            if (
                node.name.lower() == label_lower
                or (node.station_code and node.station_code.lower() == label_lower)
            ):
                return node
        return None

    async def _try_census_village(self, label: str) -> ResolutionResult | None:
        """
        Query the census_villages table using pg_trgm fuzzy matching.
        If found, resolve to the nearest transit node.
        """
        pool = await get_pool()

        try:
            rows = await pool.fetch(
                """
                SELECT village_name, district, state, lat, lng
                FROM census_villages
                WHERE similarity(village_name, $1) > $2
                ORDER BY similarity(village_name, $1) DESC
                LIMIT 5
                """,
                label,
                MIN_VILLAGE_SIMILARITY,
            )
        except Exception as exc:
            logger.warning("Census village query failed: %s", exc)
            return None

        if not rows:
            return None

        # Take the best match
        best = rows[0]
        village_lat = float(best["lat"])
        village_lng = float(best["lng"])

        # Find nearest transit node to this village
        nearest = self._graph_store.get_nearest_node(village_lat, village_lng)
        if nearest is None:
            return None

        gap_km = _haversine_km(village_lat, village_lng, nearest.lat, nearest.lng)

        return ResolutionResult(
            node=None,  # Village itself is not a transit node
            nearest_node=nearest,
            village_lat=village_lat,
            village_lng=village_lng,
            gap_km=gap_km,
        )
