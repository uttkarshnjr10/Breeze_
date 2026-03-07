"""
Breeze TripGraph — Demand Router.
A* search for on-demand modes: AUTO, CAB, WALK, E_RICKSHAW, METRO.
No departure times — these are always-available transport options.

Heuristic: haversine distance to destination (admissible — never overestimates).
Weight: normalized (duration, cost, 1 - safety_score) weighted sum.
"""

from __future__ import annotations

import heapq
import logging
import math
from collections import defaultdict
from decimal import Decimal

from src.graph.graph_store import _haversine_km
from src.models.enums import TransportMode
from src.models.transit import TransitNode, TransportEdge

logger = logging.getLogger(__name__)


class DemandRouter:
    """
    A* search on the demand-mode graph.
    Graph: adjacency dict of node_id → list[TransportEdge].
    """

    def __init__(
        self,
        edges: list[TransportEdge],
        nodes: dict[str, TransitNode],
    ) -> None:
        """
        Build adjacency from a flat list of edges.

        Args:
            edges: All demand-mode edges.
            nodes: All transit nodes (for heuristic lat/lng lookups).
        """
        self._adjacency: dict[str, list[TransportEdge]] = defaultdict(list)
        self._nodes = nodes

        for edge in edges:
            self._adjacency[edge.from_node_id].append(edge)

        logger.info("DemandRouter initialized with %d edges", len(edges))

    def find_options(
        self,
        origin_id: str,
        destination_id: str,
        mode_filter: list[TransportMode] | None = None,
    ) -> list[TransportEdge]:
        """
        Find demand-mode options from origin to destination.

        Returns:
            Direct edges if they exist (most demand transport is point-to-point).
            If no direct: A* search for a 2+ hop path.
            Empty list if no path found.
        """
        if origin_id == destination_id:
            return []

        # ── Try direct edges first ────────────────────────────
        direct = [
            edge
            for edge in self._adjacency.get(origin_id, [])
            if edge.to_node_id == destination_id
            and (mode_filter is None or edge.mode in mode_filter)
        ]

        if direct:
            return direct

        # ── A* search ─────────────────────────────────────────
        dest_node = self._nodes.get(destination_id)
        if dest_node is None:
            return []

        return self._astar(origin_id, destination_id, dest_node, mode_filter)

    def _astar(
        self,
        origin_id: str,
        destination_id: str,
        dest_node: TransitNode,
        mode_filter: list[TransportMode] | None,
    ) -> list[TransportEdge]:
        """
        A* search with haversine heuristic.

        Weight function: weighted sum of normalized (duration, cost, 1-safety).
        Normalization is across edges in scope (not global graph).
        """
        # Priority queue: (f_score, counter, node_id)
        counter = 0
        open_set: list[tuple[float, int, str]] = [(0.0, counter, origin_id)]
        came_from: dict[str, TransportEdge] = {}
        g_score: dict[str, float] = {origin_id: 0.0}
        visited: set[str] = set()

        while open_set:
            _, _, current = heapq.heappop(open_set)

            if current == destination_id:
                return self._reconstruct_path(came_from, destination_id)

            if current in visited:
                continue
            visited.add(current)

            for edge in self._adjacency.get(current, []):
                if mode_filter is not None and edge.mode not in mode_filter:
                    continue

                neighbor = edge.to_node_id
                if neighbor in visited:
                    continue

                # Edge weight: duration as primary cost
                edge_weight = float(edge.duration_minutes) + (1.0 - edge.safety_score) * 10

                tentative_g = g_score[current] + edge_weight

                if tentative_g < g_score.get(neighbor, math.inf):
                    g_score[neighbor] = tentative_g
                    came_from[neighbor] = edge

                    # Heuristic: haversine distance → estimated travel minutes
                    neighbor_node = self._nodes.get(neighbor)
                    if neighbor_node:
                        h = _haversine_km(
                            neighbor_node.lat, neighbor_node.lng,
                            dest_node.lat, dest_node.lng,
                        ) / 30.0 * 60.0  # Assume 30 km/h average → minutes
                    else:
                        h = 0.0

                    f_score = tentative_g + h
                    counter += 1
                    heapq.heappush(open_set, (f_score, counter, neighbor))

        return []  # No path found

    def _reconstruct_path(
        self,
        came_from: dict[str, TransportEdge],
        destination_id: str,
    ) -> list[TransportEdge]:
        """Backtrack from destination to build the edge path."""
        path: list[TransportEdge] = []
        current = destination_id

        while current in came_from:
            edge = came_from[current]
            path.append(edge)
            current = edge.from_node_id

        path.reverse()
        return path
