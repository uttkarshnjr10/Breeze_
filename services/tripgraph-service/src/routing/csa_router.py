"""
Breeze TripGraph — CSA Router (Connection Scan Algorithm).
For timetable-based modes: TRAIN, FLIGHT, BUS.

WHY CSA: Static graph algorithms (Dijkstra, Yen's K-shortest) cannot express
departure-time constraints. CSA was designed for public transit and is used by
Google Transit and OpenTripPlanner.

All datetime objects are timezone-aware (Asia/Kolkata).
"""

from __future__ import annotations

import logging
from collections import defaultdict
from datetime import datetime, timedelta

from src.models.enums import TransportMode, get_transfer_buffer
from src.models.transit import Connection
from src.metrics import routing_metrics

logger = logging.getLogger(__name__)


class CsaRouter:
    """
    Connection Scan Algorithm router.

    Accepts a list of Connection objects (one train/flight departure each),
    sorts them by departure_time, and scans linearly to find optimal routes.

    K-diverse routes are found by running CSA K times, each time removing
    the anchor connection from the previous best result.
    """

    def __init__(self, connections: list[Connection]) -> None:
        """
        Initialize with a list of timetable connections.
        Sort once — O(n log n). CSA scans are O(n) per query.
        """
        self._connections = sorted(connections, key=lambda c: c.departure_time)
        logger.info("CsaRouter initialized with %d connections", len(self._connections))

    def find_routes(
        self,
        origin_id: str,
        destination_id: str,
        earliest_departure: datetime,
        max_routes: int = 5,
        max_transfers: int = 3,
    ) -> list[list[Connection]]:
        """
        Find K diverse routes from origin to destination.

        Returns:
            List of routes, each route being a list of Connection objects.
            Empty list if no route found (never raises exceptions).
        """
        # ── Edge case: same origin and destination ────────────
        if origin_id == destination_id:
            return []

        routes: list[list[Connection]] = []
        excluded_connections: set[str] = set()  # external_ids to exclude

        for attempt in range(max_routes):
            route = self._scan(
                origin_id=origin_id,
                destination_id=destination_id,
                earliest_departure=earliest_departure,
                max_transfers=max_transfers,
                excluded_external_ids=excluded_connections,
            )

            if route is None:
                break

            routes.append(route)

            # Exclude the anchor connection for the next iteration
            # (Yen's-style spur logic for diversity)
            anchor = self._find_anchor_connection(route)
            if anchor:
                excluded_connections.add(anchor.external_id)

        routing_metrics.csa_connections_scanned.record(
            len(self._connections),
            {"origin": origin_id, "destination": destination_id},
        )

        return routes

    def _scan(
        self,
        origin_id: str,
        destination_id: str,
        earliest_departure: datetime,
        max_transfers: int,
        excluded_external_ids: set[str],
    ) -> list[Connection] | None:
        """
        Single CSA scan pass.

        Algorithm:
          1. Initialize earliest_arrival[station] = infinity for all stations.
             Set earliest_arrival[origin] = earliest_departure.
          2. Scan connections in departure-time order.
          3. For each connection:
             - Skip if excluded (for K-diverse)
             - Skip if we can't reach from_station in time
             - If arrival is better than known: record it
          4. Backtrack from destination to reconstruct the route.
        """
        # earliest_arrival[node_id] = (earliest arrival datetime, connection that got us here)
        earliest_arrival: dict[str, tuple[datetime, Connection | None]] = {}
        earliest_arrival[origin_id] = (earliest_departure, None)

        # predecessor[node_id] = Connection that was used to reach this node
        predecessor: dict[str, Connection] = {}

        # transfer_count[node_id] = number of transfers to reach this node
        transfer_count: dict[str, int] = defaultdict(int)

        # visited stations per route to detect circular journeys
        visited_per_route: dict[str, set[str]] = defaultdict(set)
        visited_per_route[origin_id] = {origin_id}

        for conn in self._connections:
            # Skip excluded connections (for K-diverse routing)
            if conn.external_id in excluded_external_ids:
                continue

            # Only consider connections departing after earliest_departure
            if conn.departure_time < earliest_departure:
                continue

            # Check if we can reach the departure station in time
            if conn.from_node_id not in earliest_arrival:
                continue

            arrival_at_from, _ = earliest_arrival[conn.from_node_id]

            # Determine required transfer buffer
            if conn.from_node_id in predecessor:
                prev_conn = predecessor[conn.from_node_id]
                buffer_minutes = get_transfer_buffer(prev_conn.mode, conn.mode)
            else:
                buffer_minutes = 0  # Origin station — no transfer needed

            required_departure = arrival_at_from + timedelta(minutes=buffer_minutes)
            if conn.departure_time < required_departure:
                continue  # Can't make this connection

            # Check max transfers
            transfers = transfer_count[conn.from_node_id]
            if conn.from_node_id in predecessor:
                prev = predecessor[conn.from_node_id]
                if prev.external_id != conn.external_id:
                    transfers += 1
                    if transfers > max_transfers:
                        continue

            # Circular journey detection
            from_visited = visited_per_route.get(conn.from_node_id, set())
            if conn.to_node_id in from_visited:
                continue

            # Check if this connection improves the arrival at to_node
            current_arrival = earliest_arrival.get(conn.to_node_id)
            if current_arrival is None or conn.arrival_time < current_arrival[0]:
                earliest_arrival[conn.to_node_id] = (conn.arrival_time, conn)
                predecessor[conn.to_node_id] = conn
                transfer_count[conn.to_node_id] = transfers

                # Track visited nodes
                new_visited = from_visited | {conn.to_node_id}
                visited_per_route[conn.to_node_id] = new_visited

        # ── Backtrack to reconstruct route ────────────────────
        if destination_id not in predecessor:
            return None

        route: list[Connection] = []
        current_node = destination_id

        while current_node in predecessor:
            conn = predecessor[current_node]
            route.append(conn)
            current_node = conn.from_node_id

        route.reverse()
        return route

    def _find_anchor_connection(self, route: list[Connection]) -> Connection | None:
        """Find the anchor (most important) connection in a route."""
        if not route:
            return None

        # Anchor = highest mode hierarchy level, break ties by duration
        from src.models.enums import MODE_HIERARCHY

        best: Connection | None = None
        best_priority = -1

        for conn in route:
            priority = MODE_HIERARCHY.get(conn.mode, 0)
            if priority > best_priority:
                best = conn
                best_priority = priority

        return best
