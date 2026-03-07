"""
Breeze TripGraph — Route Orchestrator.
Single entry point for all route search requests.
Coordinates Location Resolver → CSA/Demand Routers → Result Assembler.
Redis caching with thundering-herd lock (SET NX, 30s TTL).
No routing logic lives here — pure orchestration.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
from datetime import datetime, timezone
from decimal import Decimal

import httpx
import redis.asyncio as aioredis

from src.config import settings
from src.graph.graph_store import GraphStore
from src.location.location_resolver import LocationResolver
from src.models.enums import RoutePriority, TransportMode
from src.models.transit import Connection, TransportEdge
from src.models.trip import SearchInput, TripObject, TripResult
from src.results.result_assembler import ResultAssembler
from src.routing.csa_router import CsaRouter
from src.routing.demand_router import DemandRouter
from src.metrics import routing_metrics

logger = logging.getLogger(__name__)


class RouteOrchestrator:
    """
    Coordinates all routing modules.
    Flow: validate → resolve locations → fetch timetable →
          CSA + demand → assemble → cache → return.
    """

    def __init__(
        self,
        graph_store: GraphStore,
        redis_client: aioredis.Redis,
    ) -> None:
        self._graph_store = graph_store
        self._location_resolver = LocationResolver(graph_store)
        self._result_assembler = ResultAssembler(graph_store)
        self._redis = redis_client
        self._http = httpx.AsyncClient(timeout=15.0)

    async def search(self, search_input: SearchInput) -> TripResult:
        """
        Execute a route search.
        Handles all 12 edge cases specified in the architecture doc.
        """
        start_time = time.monotonic()
        warnings: list[str] = []

        # ── 1. Validate input ─────────────────────────────────
        # Edge case 1: same origin and destination
        if (
            search_input.origin_lat == search_input.destination_lat
            and search_input.origin_lng == search_input.destination_lng
        ):
            return TripResult(
                routing_warnings=["Origin and destination are the same."],
                query_duration_ms=_elapsed_ms(start_time),
            )

        # ── 2. Resolve locations ──────────────────────────────
        origin_result, dest_result = await asyncio.gather(
            self._location_resolver.resolve(
                lat=search_input.origin_lat,
                lng=search_input.origin_lng,
                label=search_input.origin_label,
            ),
            self._location_resolver.resolve(
                lat=search_input.destination_lat,
                lng=search_input.destination_lng,
                label=search_input.destination_label,
            ),
        )

        if origin_result.warnings:
            warnings.extend(origin_result.warnings)
        if dest_result.warnings:
            warnings.extend(dest_result.warnings)

        # Use resolved node or nearest node (for villages)
        origin_node = origin_result.node
        dest_node = dest_result.node or dest_result.nearest_node

        if origin_node is None or dest_node is None:
            return TripResult(
                routing_warnings=warnings + [
                    "Could not resolve origin or destination to a transit node."
                ],
                query_duration_ms=_elapsed_ms(start_time),
            )

        # ── 3. Check cache ────────────────────────────────────
        cache_key = _make_cache_key(
            origin_node.id,
            dest_node.id,
            search_input.departure_date.isoformat(),
            search_input.priority.value,
        )

        cached = await self._try_cache_get(cache_key)
        if cached is not None:
            routing_metrics.cache_hit_ratio.add(1)
            cached.query_duration_ms = _elapsed_ms(start_time)
            return cached

        # ── 4. Acquire thundering-herd lock ───────────────────
        lock_key = f"lock:{cache_key}"
        acquired = await self._redis.set(lock_key, "1", ex=30, nx=True)

        if not acquired:
            # Another request is computing this route — wait and retry cache
            await asyncio.sleep(1.0)
            cached = await self._try_cache_get(cache_key)
            if cached is not None:
                cached.query_duration_ms = _elapsed_ms(start_time)
                return cached

        try:
            # ── 5. Fetch timetable connections ────────────────
            connections = await self._fetch_connections(
                origin_node.id,
                dest_node.id,
                search_input.departure_date.isoformat(),
            )

            # ── 6. Run CSA Router ─────────────────────────────
            departure_dt = datetime(
                search_input.departure_date.year,
                search_input.departure_date.month,
                search_input.departure_date.day,
                0, 0, 0,
                tzinfo=timezone.utc,
            )

            csa_routes: list[list[Connection]] = []
            if connections:
                # Filter out excluded modes
                filtered = [
                    c for c in connections
                    if c.mode not in search_input.exclude_modes
                ]
                if filtered:
                    csa_router = CsaRouter(filtered)
                    csa_routes = csa_router.find_routes(
                        origin_id=origin_node.id,
                        destination_id=dest_node.id,
                        earliest_departure=departure_dt,
                        max_routes=5,
                        max_transfers=search_input.max_transfers,
                    )

            # ── 7. Run Demand Router ──────────────────────────
            demand_edges = await self._fetch_demand_edges(origin_node.id, dest_node.id)
            demand_options: list[TransportEdge] = []
            if demand_edges:
                nodes_dict = {n.id: n for n in self._graph_store.get_all_nodes()}
                demand_router = DemandRouter(demand_edges, nodes_dict)
                demand_options = demand_router.find_options(
                    origin_id=origin_node.id,
                    destination_id=dest_node.id,
                    mode_filter=[
                        m for m in [
                            TransportMode.AUTO, TransportMode.CAB,
                            TransportMode.METRO, TransportMode.WALK,
                            TransportMode.E_RICKSHAW,
                        ]
                        if m not in search_input.exclude_modes
                    ],
                )

            # ── 8. Assemble results ───────────────────────────
            trip_options = self._result_assembler.assemble(
                csa_routes=csa_routes,
                demand_edges=demand_options,
                priority=search_input.priority,
                village_lat=dest_result.village_lat,
                village_lng=dest_result.village_lng,
                last_confirmed_node_id=dest_node.id if dest_result.nearest_node else None,
            )

            # ── 9. Edge case 2 & 5: disconnection check ──────
            if not trip_options:
                reachable = self._result_assembler.check_reachability(
                    origin_node.id, dest_node.id,
                )
                if not reachable:
                    warnings.append(
                        "No confirmed transit route exists between these points. "
                        "Rail or road links may be unavailable."
                    )
                else:
                    warnings.append(
                        "No departures available for the selected date/time. "
                        "Try an earlier departure or a different date."
                    )

            # ── 10. Build result ──────────────────────────────
            result = TripResult(
                options=trip_options,
                origin_resolved=origin_node.id,
                destination_resolved=dest_node.id,
                destination_nearest_node=(
                    dest_result.nearest_node.id if dest_result.nearest_node else None
                ),
                routing_warnings=warnings,
                query_duration_ms=_elapsed_ms(start_time),
            )

            # ── 11. Cache result ──────────────────────────────
            await self._try_cache_set(cache_key, result)

            # ── 12. Emit metrics ──────────────────────────────
            routing_metrics.route_search_total.add(
                1,
                {
                    "priority": search_input.priority.value,
                    "route_status": (
                        trip_options[0].route_status.value if trip_options else "NONE"
                    ),
                },
            )
            routing_metrics.route_search_duration.record(
                result.query_duration_ms / 1000.0,
                {"priority": search_input.priority.value},
            )
            routing_metrics.routes_found_count.record(len(trip_options))

            logger.info(
                "Route search: %s → %s | %s | %d routes | %.0fms",
                origin_node.id,
                dest_node.id,
                search_input.priority.value,
                len(trip_options),
                result.query_duration_ms,
            )

            return result

        finally:
            # Release thundering-herd lock
            await self._redis.delete(lock_key)

    # ── Data Fetchers ─────────────────────────────────────────

    async def _fetch_connections(
        self, origin_id: str, destination_id: str, departure_date: str,
    ) -> list[Connection]:
        """
        Fetch timetable connections from Transit Intelligence Service.
        Returns empty list on failure (partial failure is acceptable).
        """
        try:
            response = await self._http.get(
                f"{settings.transit_service_url}/api/v1/connections",
                params={
                    "origin": origin_id,
                    "destination": destination_id,
                    "date": departure_date,
                },
            )
            if response.status_code != 200:
                logger.warning(
                    "Transit service returned %d for connections", response.status_code,
                )
                return []

            data = response.json()
            connections: list[Connection] = []
            for item in data.get("connections", []):
                connections.append(Connection(
                    from_node_id=item["from_node_id"],
                    to_node_id=item["to_node_id"],
                    departure_time=datetime.fromisoformat(item["departure_time"]),
                    arrival_time=datetime.fromisoformat(item["arrival_time"]),
                    mode=TransportMode(item["mode"]),
                    external_id=item["external_id"],
                    cost_inr=Decimal(str(item["cost_inr"])),
                    safety_score=float(item.get("safety_score", 0.8)),
                    confidence=float(item.get("confidence", 0.9)),
                    source=item.get("source", "transit_service"),
                ))
            return connections

        except Exception as exc:
            logger.error("Failed to fetch connections: %s", exc)
            return []

    async def _fetch_demand_edges(
        self, origin_id: str, destination_id: str,
    ) -> list[TransportEdge]:
        """
        Fetch on-demand transport edges from Flock Intelligence Service.
        Returns empty list on failure.
        """
        try:
            response = await self._http.get(
                f"{settings.flock_service_url}/api/v1/edges",
                params={"origin": origin_id, "destination": destination_id},
            )
            if response.status_code != 200:
                return []

            data = response.json()
            edges: list[TransportEdge] = []
            for item in data.get("edges", []):
                edges.append(TransportEdge(
                    from_node_id=item["from_node_id"],
                    to_node_id=item["to_node_id"],
                    mode=TransportMode(item["mode"]),
                    duration_minutes=int(item["duration_minutes"]),
                    cost_inr=Decimal(str(item["cost_inr"])),
                    safety_score=float(item.get("safety_score", 0.7)),
                    confidence=float(item.get("confidence", 0.6)),
                    source=item.get("source", "flock"),
                ))
            return edges

        except Exception as exc:
            logger.error("Failed to fetch demand edges: %s", exc)
            return []

    # ── Cache Helpers ─────────────────────────────────────────

    async def _try_cache_get(self, key: str) -> TripResult | None:
        """Try to read from Redis cache. Returns None on miss or error."""
        try:
            raw = await self._redis.get(f"route:{key}")
            if raw is None:
                return None
            data = json.loads(raw)
            return self._deserialize_result(data)
        except Exception:
            return None

    async def _try_cache_set(self, key: str, result: TripResult) -> None:
        """Write result to Redis cache with TTL."""
        try:
            serialized = self._serialize_result(result)
            await self._redis.setex(
                f"route:{key}",
                settings.route_cache_ttl_seconds,
                json.dumps(serialized),
            )
        except Exception as exc:
            logger.warning("Cache write failed: %s", exc)

    def _serialize_result(self, result: TripResult) -> dict:
        """Convert TripResult to a JSON-serializable dict."""
        return {
            "options": [
                {
                    "trip_id": t.trip_id,
                    "total_duration_minutes": t.total_duration_minutes,
                    "total_cost_inr": str(t.total_cost_inr),
                    "overall_confidence": t.overall_confidence,
                    "overall_safety_score": t.overall_safety_score,
                    "composite_score": t.composite_score,
                    "has_unconfirmed_legs": t.has_unconfirmed_legs,
                    "route_status": t.route_status.value,
                    "anchor_segment_index": t.anchor_segment_index,
                    "segments": [
                        {
                            "from_node_id": s.from_node_id,
                            "to_node_id": s.to_node_id,
                            "mode": s.mode.value,
                            "leg_type": s.leg_type.value,
                            "duration_minutes": s.duration_minutes,
                            "cost_inr": str(s.cost_inr),
                            "safety_score": s.safety_score,
                            "confidence": s.confidence,
                            "source": s.source,
                            "departure_time": (
                                s.departure_time.isoformat() if s.departure_time else None
                            ),
                            "arrival_time": (
                                s.arrival_time.isoformat() if s.arrival_time else None
                            ),
                            "external_id": s.external_id,
                            "distance_km": s.distance_km,
                            "note": s.note,
                        }
                        for s in t.segments
                    ],
                }
                for t in result.options
            ],
            "origin_resolved": result.origin_resolved,
            "destination_resolved": result.destination_resolved,
            "destination_nearest_node": result.destination_nearest_node,
            "routing_warnings": result.routing_warnings,
        }

    def _deserialize_result(self, data: dict) -> TripResult:
        """Reconstruct TripResult from cached JSON."""
        from src.models.enums import LegType, RouteStatus, TransportMode
        from src.models.trip import RouteSegment, TripObject

        options: list[TripObject] = []
        for opt in data.get("options", []):
            segments = [
                RouteSegment(
                    from_node_id=s["from_node_id"],
                    to_node_id=s["to_node_id"],
                    mode=TransportMode(s["mode"]),
                    leg_type=LegType(s["leg_type"]),
                    duration_minutes=s["duration_minutes"],
                    cost_inr=Decimal(s["cost_inr"]),
                    safety_score=s["safety_score"],
                    confidence=s["confidence"],
                    source=s["source"],
                    departure_time=(
                        datetime.fromisoformat(s["departure_time"])
                        if s.get("departure_time") else None
                    ),
                    arrival_time=(
                        datetime.fromisoformat(s["arrival_time"])
                        if s.get("arrival_time") else None
                    ),
                    external_id=s.get("external_id"),
                    distance_km=s.get("distance_km", 0.0),
                    note=s.get("note"),
                )
                for s in opt.get("segments", [])
            ]

            trip = TripObject(
                trip_id=opt["trip_id"],
                segments=segments,
                total_duration_minutes=opt["total_duration_minutes"],
                total_cost_inr=Decimal(opt["total_cost_inr"]),
                anchor_segment_index=opt.get("anchor_segment_index", 0),
                overall_confidence=opt["overall_confidence"],
                overall_safety_score=opt["overall_safety_score"],
                composite_score=opt["composite_score"],
                has_unconfirmed_legs=opt["has_unconfirmed_legs"],
                route_status=RouteStatus(opt["route_status"]),
            )
            options.append(trip)

        return TripResult(
            options=options,
            origin_resolved=data.get("origin_resolved"),
            destination_resolved=data.get("destination_resolved"),
            destination_nearest_node=data.get("destination_nearest_node"),
            routing_warnings=data.get("routing_warnings", []),
        )


# ── Helpers ─────────────────────────────────────────────────────

def _make_cache_key(
    origin_id: str, dest_id: str, departure_date: str, priority: str,
) -> str:
    """SHA-256 cache key from resolved node IDs + date + priority."""
    raw = f"{origin_id}:{dest_id}:{departure_date}:{priority}"
    return hashlib.sha256(raw.encode()).hexdigest()


def _elapsed_ms(start: float) -> float:
    """Milliseconds since start time."""
    return (time.monotonic() - start) * 1000.0
