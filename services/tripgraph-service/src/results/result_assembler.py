"""
Breeze TripGraph — ResultAssembler.
Converts raw routing output into scored, ranked TripObjects.

Pipeline:
  1. Segment assembly + LegType assignment
  2. Confidence propagation (min of all legs)
  3. Composite scoring (time, cost, safety weights by priority)
  4. Deduplication by anchor external_id
  5. Pareto filtering (remove dominated options)
  6. Partial route handling (village last-mile)
  7. Disconnection detection (BFS reachability)
"""

from __future__ import annotations

import logging
from collections import deque
from decimal import Decimal

from src.graph.graph_store import GraphStore, _haversine_km
from src.models.enums import (
    MODE_HIERARCHY,
    LegType,
    RoutePriority,
    RouteStatus,
    TransportMode,
)
from src.models.transit import Connection, TransportEdge
from src.models.trip import RouteSegment, TripObject

logger = logging.getLogger(__name__)

# ── Priority weight profiles ────────────────────────────────────

PRIORITY_WEIGHTS: dict[RoutePriority, tuple[float, float, float]] = {
    #                         time   cost   safety
    RoutePriority.FASTEST:  (0.70,  0.20,  0.10),
    RoutePriority.CHEAPEST: (0.20,  0.70,  0.10),
    RoutePriority.SAFEST:   (0.20,  0.20,  0.60),
    RoutePriority.BALANCED: (0.40,  0.40,  0.20),
}


class ResultAssembler:
    """Assembles, scores, filters, and ranks route results."""

    def __init__(self, graph_store: GraphStore) -> None:
        self._graph_store = graph_store

    def assemble(
        self,
        csa_routes: list[list[Connection]],
        demand_edges: list[TransportEdge],
        priority: RoutePriority,
        village_lat: float | None = None,
        village_lng: float | None = None,
        last_confirmed_node_id: str | None = None,
    ) -> list[TripObject]:
        """
        Full assembly pipeline.

        Args:
            csa_routes: Routes from CSA (timetable-based).
            demand_edges: First/last mile options from DemandRouter.
            priority: User preference for scoring.
            village_lat/lng: If destination is a village, actual coordinates.
            last_confirmed_node_id: Last transit node before village gap.
        """
        trips: list[TripObject] = []

        # ── Step 1: Build TripObjects from CSA routes ─────────
        for route in csa_routes:
            segments = self._connections_to_segments(route)
            if not segments:
                continue

            trip = TripObject(segments=segments)

            # Assign LegTypes
            self._assign_leg_types(trip)

            # Calculate totals
            trip.total_duration_minutes = sum(s.duration_minutes for s in trip.segments)
            trip.total_cost_inr = sum(s.cost_inr for s in trip.segments)

            trips.append(trip)

        # ── Step 2: Confidence propagation ────────────────────
        for trip in trips:
            self._propagate_confidence(trip)

        # ── Step 3: Partial route (village last-mile) ─────────
        if village_lat is not None and village_lng is not None and last_confirmed_node_id:
            for trip in trips:
                self._append_village_last_mile(
                    trip, last_confirmed_node_id, village_lat, village_lng,
                )

        # ── Step 4: Composite scoring ─────────────────────────
        self._score_trips(trips, priority)

        # ── Step 5: Deduplication by anchor external_id ───────
        trips = self._deduplicate(trips)

        # ── Step 6: Pareto filtering ──────────────────────────
        trips = self._pareto_filter(trips)

        # ── Step 7: Sort by composite score (lower = better) ──
        trips.sort(key=lambda t: t.composite_score)

        return trips

    # ── Step 1: Segment Assembly ──────────────────────────────

    def _connections_to_segments(
        self, connections: list[Connection],
    ) -> list[RouteSegment]:
        """Convert a CSA route into RouteSegments."""
        segments: list[RouteSegment] = []

        for conn in connections:
            duration = int((conn.arrival_time - conn.departure_time).total_seconds() / 60)

            # Estimate distance from lat/lng if nodes exist
            from_node = self._graph_store.get_node(conn.from_node_id)
            to_node = self._graph_store.get_node(conn.to_node_id)
            distance_km = 0.0
            if from_node and to_node:
                distance_km = _haversine_km(
                    from_node.lat, from_node.lng, to_node.lat, to_node.lng,
                )

            segments.append(RouteSegment(
                from_node_id=conn.from_node_id,
                to_node_id=conn.to_node_id,
                mode=conn.mode,
                leg_type=LegType.LOCAL_CONNECTOR,  # Will be reassigned
                duration_minutes=duration,
                cost_inr=conn.cost_inr,
                safety_score=conn.safety_score,
                confidence=conn.confidence,
                source=conn.source,
                departure_time=conn.departure_time,
                arrival_time=conn.arrival_time,
                external_id=conn.external_id,
                distance_km=distance_km,
            ))

        return segments

    def _assign_leg_types(self, trip: TripObject) -> None:
        """
        Assign LegType to each segment based on mode hierarchy.
        Anchor = highest hierarchy mode, break ties by distance.
        """
        if not trip.segments:
            return

        if len(trip.segments) == 1:
            seg = trip.segments[0]
            # Single-leg: ANCHOR if > 80km, else LOCAL_CONNECTOR
            leg_type = LegType.ANCHOR if seg.distance_km > 80 else LegType.LOCAL_CONNECTOR
            trip.segments[0] = RouteSegment(
                **{**seg.__dict__, "leg_type": leg_type},  # type: ignore[arg-type]
            )
            trip.anchor_segment_index = 0
            return

        # Find anchor by mode hierarchy, then by distance
        anchor_idx = 0
        anchor_priority = -1
        anchor_distance = 0.0

        for i, seg in enumerate(trip.segments):
            priority = MODE_HIERARCHY.get(seg.mode, 0)
            if priority > anchor_priority or (
                priority == anchor_priority and seg.distance_km > anchor_distance
            ):
                anchor_idx = i
                anchor_priority = priority
                anchor_distance = seg.distance_km

        # Assign types
        new_segments: list[RouteSegment] = []
        for i, seg in enumerate(trip.segments):
            if i == anchor_idx:
                leg_type = LegType.ANCHOR
            elif i < anchor_idx:
                is_local = MODE_HIERARCHY.get(seg.mode, 0) <= 2
                leg_type = LegType.FIRST_MILE if is_local else LegType.LOCAL_CONNECTOR
            else:
                is_local = MODE_HIERARCHY.get(seg.mode, 0) <= 2
                leg_type = LegType.LAST_MILE if is_local else LegType.LOCAL_CONNECTOR

            new_segments.append(RouteSegment(
                from_node_id=seg.from_node_id,
                to_node_id=seg.to_node_id,
                mode=seg.mode,
                leg_type=leg_type,
                duration_minutes=seg.duration_minutes,
                cost_inr=seg.cost_inr,
                safety_score=seg.safety_score,
                confidence=seg.confidence,
                source=seg.source,
                departure_time=seg.departure_time,
                arrival_time=seg.arrival_time,
                external_id=seg.external_id,
                distance_km=seg.distance_km,
                note=seg.note,
            ))

        trip.segments = new_segments
        trip.anchor_segment_index = anchor_idx

    # ── Step 2: Confidence Propagation ────────────────────────

    def _propagate_confidence(self, trip: TripObject) -> None:
        """Chain is as strong as its weakest link."""
        if not trip.segments:
            return

        trip.overall_confidence = min(s.confidence for s in trip.segments)
        trip.overall_safety_score = min(s.safety_score for s in trip.segments)
        trip.has_unconfirmed_legs = any(s.confidence < 0.5 for s in trip.segments)

        if all(s.confidence >= 0.85 for s in trip.segments):
            trip.route_status = RouteStatus.CONFIRMED
        elif any(s.confidence < 0.5 for s in trip.segments):
            trip.route_status = RouteStatus.UNCONFIRMED
        else:
            trip.route_status = RouteStatus.PARTIAL

    # ── Step 3: Composite Scoring ─────────────────────────────

    def _score_trips(
        self, trips: list[TripObject], priority: RoutePriority,
    ) -> None:
        """Score and rank trips by weighted composite of time, cost, safety."""
        if len(trips) <= 1:
            if trips:
                trips[0].composite_score = 0.0
            return

        # Gather min/max for normalization
        durations = [t.total_duration_minutes for t in trips]
        costs = [float(t.total_cost_inr) for t in trips]
        safeties = [t.overall_safety_score for t in trips]

        min_d, max_d = min(durations), max(durations)
        min_c, max_c = min(costs), max(costs)

        w_time, w_cost, w_safety = PRIORITY_WEIGHTS[priority]

        for trip in trips:
            # Normalize (handle divide by zero)
            t_norm = (
                (trip.total_duration_minutes - min_d) / (max_d - min_d)
                if max_d != min_d else 0.0
            )
            c_norm = (
                (float(trip.total_cost_inr) - min_c) / (max_c - min_c)
                if max_c != min_c else 0.0
            )
            s_norm = 1.0 - trip.overall_safety_score  # Invert: higher safety = lower penalty

            trip.composite_score = w_time * t_norm + w_cost * c_norm + w_safety * s_norm

    # ── Step 4: Deduplication ─────────────────────────────────

    def _deduplicate(self, trips: list[TripObject]) -> list[TripObject]:
        """
        Remove duplicates sharing the same anchor external_id.
        Keep the one with the better (lower) composite_score.
        """
        seen: dict[str, TripObject] = {}

        for trip in trips:
            if not trip.segments:
                continue

            anchor_idx = trip.anchor_segment_index
            if anchor_idx < len(trip.segments):
                ext_id = trip.segments[anchor_idx].external_id or ""
            else:
                ext_id = ""

            if not ext_id:
                seen[trip.trip_id] = trip
                continue

            existing = seen.get(ext_id)
            if existing is None or trip.composite_score < existing.composite_score:
                seen[ext_id] = trip

        return list(seen.values())

    # ── Step 5: Pareto Filtering ──────────────────────────────

    def _pareto_filter(self, trips: list[TripObject]) -> list[TripObject]:
        """
        Remove dominated options.
        A trip is dominated if another is better on ALL of time, cost, AND safety.
        """
        if len(trips) <= 1:
            return trips

        pareto: list[TripObject] = []

        for trip in trips:
            is_dominated = False
            for other in trips:
                if other is trip:
                    continue
                if (
                    other.total_duration_minutes <= trip.total_duration_minutes
                    and float(other.total_cost_inr) <= float(trip.total_cost_inr)
                    and other.overall_safety_score >= trip.overall_safety_score
                    and (
                        other.total_duration_minutes < trip.total_duration_minutes
                        or float(other.total_cost_inr) < float(trip.total_cost_inr)
                        or other.overall_safety_score > trip.overall_safety_score
                    )
                ):
                    is_dominated = True
                    break

            if not is_dominated:
                pareto.append(trip)

        return pareto

    # ── Step 6: Partial Route (Village Last Mile) ─────────────

    def _append_village_last_mile(
        self,
        trip: TripObject,
        last_node_id: str,
        village_lat: float,
        village_lng: float,
    ) -> None:
        """Append an UNCONFIRMED last-mile segment for village destinations."""
        last_node = self._graph_store.get_node(last_node_id)
        if last_node is None:
            return

        gap_km = _haversine_km(last_node.lat, last_node.lng, village_lat, village_lng)
        # Estimate: 20 km/h on rural roads
        duration_minutes = int(gap_km / 20.0 * 60.0)

        last_mile = RouteSegment(
            from_node_id=last_node_id,
            to_node_id=f"village:{village_lat:.6f},{village_lng:.6f}",
            mode=TransportMode.AUTO,
            leg_type=LegType.LAST_MILE,
            duration_minutes=max(duration_minutes, 10),  # Minimum 10 min
            cost_inr=Decimal(str(round(gap_km * 15, 2))),  # ~₹15/km estimate
            safety_score=0.5,
            confidence=0.35,
            source="estimate",
            distance_km=gap_km,
            note="Community route — no confirmed transit. Ask locals at arrival.",
        )

        trip.segments.append(last_mile)
        trip.total_duration_minutes += last_mile.duration_minutes
        trip.total_cost_inr += last_mile.cost_inr
        trip.has_unconfirmed_legs = True
        trip.route_status = RouteStatus.PARTIAL

    # ── Step 7: Disconnection Detection ───────────────────────

    def check_reachability(
        self, origin_id: str, destination_id: str,
    ) -> bool:
        """BFS on adjacency graph to check if destination is reachable."""
        visited: set[str] = set()
        queue: deque[str] = deque([origin_id])

        while queue:
            current = queue.popleft()
            if current == destination_id:
                return True
            if current in visited:
                continue
            visited.add(current)

            for neighbor in self._graph_store.get_connected_nodes(current):
                if neighbor not in visited:
                    queue.append(neighbor)

        return False
