"""
Breeze TripGraph — GraphStore.
Dual-purpose data structure: scipy cKDTree for spatial queries +
adjacency dict for topology. Refreshes every 6 hours via APScheduler.

NEVER import NetworkX here. scipy.spatial + plain dicts only.
"""

from __future__ import annotations

import asyncio
import logging
import math
from collections import defaultdict

import numpy as np
from numpy.typing import NDArray
from scipy.spatial import cKDTree

from src.database import get_pool
from src.models.enums import NodeType
from src.models.transit import TransitNode

logger = logging.getLogger(__name__)

# Approximate conversion: 1 degree latitude ≈ 111.32 km
KM_PER_DEGREE = 111.32


class GraphStore:
    """
    Singleton spatial index + adjacency registry for the transit network.

    Component A: scipy cKDTree — O(log n) nearest-neighbor queries.
    Component B: adjacency dict — node_id → list[connected node_ids].

    Both are rebuilt atomically every 6 hours.
    """

    def __init__(self) -> None:
        self._nodes: dict[str, TransitNode] = {}
        self._coords: NDArray[np.float64] | None = None
        self._tree: cKDTree | None = None
        self._node_ids_by_index: list[str] = []
        self._adjacency: dict[str, list[str]] = defaultdict(list)
        self._lock = asyncio.Lock()
        self._is_ready = False

    @property
    def is_ready(self) -> bool:
        """True when initial load is complete and queries can be served."""
        return self._is_ready

    @property
    def node_count(self) -> int:
        """Number of transit nodes in the store."""
        return len(self._nodes)

    # ── Initialization ──────────────────────────────────────────

    async def initialize(self) -> None:
        """Load all transit nodes from PostgreSQL and build indices."""
        logger.info("GraphStore: initializing from database...")
        await self.refresh()
        self._is_ready = True
        logger.info("GraphStore: ready — %d nodes loaded", len(self._nodes))

    async def refresh(self) -> None:
        """
        Reload all transit nodes and adjacency data from PostgreSQL.
        Builds new cKDTree and adjacency dict, then swaps atomically.
        """
        pool = await get_pool()

        # ── Load nodes ──────────────────────────────────────────
        rows = await pool.fetch(
            "SELECT id, name, lat, lng, node_type, station_code, city, state, is_verified "
            "FROM transit_nodes"
        )

        new_nodes: dict[str, TransitNode] = {}
        coords_list: list[tuple[float, float]] = []
        node_ids: list[str] = []

        for row in rows:
            node = TransitNode(
                id=row["id"],
                name=row["name"],
                lat=float(row["lat"]),
                lng=float(row["lng"]),
                node_type=NodeType(row["node_type"]),
                station_code=row["station_code"],
                city=row["city"],
                state=row["state"],
                is_verified=row["is_verified"],
            )
            new_nodes[node.id] = node
            coords_list.append((node.lat, node.lng))
            node_ids.append(node.id)

        # ── Build cKDTree ───────────────────────────────────────
        new_tree: cKDTree | None = None
        new_coords: NDArray[np.float64] | None = None

        if coords_list:
            new_coords = np.array(coords_list, dtype=np.float64)
            new_tree = cKDTree(new_coords)

        # ── Load adjacency (permanent topology) ────────────────
        # This reads from a simple adjacency table if it exists,
        # or can be derived from known rail/metro links.
        new_adjacency: dict[str, list[str]] = defaultdict(list)

        try:
            adj_rows = await pool.fetch(
                "SELECT from_node_id, to_node_id FROM node_connections"
            )
            for adj_row in adj_rows:
                from_id = adj_row["from_node_id"]
                to_id = adj_row["to_node_id"]
                new_adjacency[from_id].append(to_id)
                new_adjacency[to_id].append(from_id)  # bidirectional
        except Exception:
            # Table may not exist yet — adjacency will be empty
            logger.warning("GraphStore: node_connections table not found, adjacency empty")

        # ── Atomic swap ─────────────────────────────────────────
        async with self._lock:
            self._nodes = new_nodes
            self._coords = new_coords
            self._tree = new_tree
            self._node_ids_by_index = node_ids
            self._adjacency = new_adjacency

        logger.info("GraphStore: refreshed — %d nodes, %d adjacency entries",
                     len(new_nodes), sum(len(v) for v in new_adjacency.values()))

    # ── Query Methods ───────────────────────────────────────────

    def get_node(self, node_id: str) -> TransitNode | None:
        """Get a transit node by ID. O(1)."""
        return self._nodes.get(node_id)

    def node_exists(self, node_id: str) -> bool:
        """Check if a node exists. O(1)."""
        return node_id in self._nodes

    def get_all_nodes(self) -> list[TransitNode]:
        """Get all transit nodes (for CSA initialization)."""
        return list(self._nodes.values())

    def get_nodes_within_radius(
        self,
        lat: float,
        lng: float,
        radius_km: float,
    ) -> list[tuple[TransitNode, float]]:
        """
        Find all transit nodes within a given radius of a GPS coordinate.
        Returns nodes sorted by distance with their distances in km.
        Uses cKDTree.query_ball_point — O(log n + k) where k = results.
        """
        if self._tree is None or self._coords is None:
            return []

        # Convert km to approximate degrees
        radius_deg = radius_km / KM_PER_DEGREE

        query_point = np.array([lat, lng], dtype=np.float64)
        indices = self._tree.query_ball_point(query_point, radius_deg)

        results: list[tuple[TransitNode, float]] = []
        for idx in indices:
            node_id = self._node_ids_by_index[idx]
            node = self._nodes.get(node_id)
            if node is None:
                continue
            distance_km = _haversine_km(lat, lng, node.lat, node.lng)
            if distance_km <= radius_km:
                results.append((node, distance_km))

        results.sort(key=lambda x: x[1])
        return results

    def get_nearest_node(
        self,
        lat: float,
        lng: float,
        node_types: list[NodeType] | None = None,
    ) -> TransitNode | None:
        """
        Find the single closest transit node.
        Optionally filter by node type (e.g., only RAILWAY_STATION).
        """
        if self._tree is None or self._coords is None:
            return None

        if node_types is None:
            # Simple nearest query
            query_point = np.array([lat, lng], dtype=np.float64)
            _, idx = self._tree.query(query_point)
            node_id = self._node_ids_by_index[int(idx)]
            return self._nodes.get(node_id)

        # Filter by type: query K nearest, filter, return first match
        k = min(50, len(self._node_ids_by_index))
        query_point = np.array([lat, lng], dtype=np.float64)
        _, indices = self._tree.query(query_point, k=k)

        idx_array = np.atleast_1d(indices)
        for idx in idx_array:
            node_id = self._node_ids_by_index[int(idx)]
            node = self._nodes.get(node_id)
            if node and node.node_type in node_types:
                return node

        return None

    def get_connected_nodes(self, node_id: str) -> list[str]:
        """Get all directly connected node IDs (topology only, no times)."""
        return self._adjacency.get(node_id, [])


# ── Haversine helper ────────────────────────────────────────────

def _haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Haversine distance between two GPS coordinates in kilometers."""
    r = 6371.0  # Earth radius in km
    lat1_r, lat2_r = math.radians(lat1), math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = math.sin(dlat / 2) ** 2 + math.cos(lat1_r) * math.cos(lat2_r) * math.sin(dlng / 2) ** 2
    return r * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
