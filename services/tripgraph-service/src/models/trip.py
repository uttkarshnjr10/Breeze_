"""
Breeze TripGraph — Trip data models.
RouteSegment, TripObject, TripResult, SearchInput.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal
from uuid import uuid4

from src.models.enums import (
    LegType,
    RoutePriority,
    RouteStatus,
    TransportMode,
)


@dataclass(frozen=True, slots=True)
class RouteSegment:
    """A resolved leg of a journey with assigned LegType."""

    from_node_id: str
    to_node_id: str
    mode: TransportMode
    leg_type: LegType
    duration_minutes: int
    cost_inr: Decimal
    safety_score: float
    confidence: float
    source: str
    departure_time: datetime | None = None  # None for demand segments
    arrival_time: datetime | None = None
    external_id: str | None = None  # train/flight number
    distance_km: float = 0.0
    note: str | None = None


@dataclass(slots=True)
class TripObject:
    """A complete trip with segments, scoring, and status."""

    trip_id: str = field(default_factory=lambda: str(uuid4()))
    segments: list[RouteSegment] = field(default_factory=list)
    total_duration_minutes: int = 0
    total_cost_inr: Decimal = Decimal("0.00")
    anchor_segment_index: int = 0
    overall_confidence: float = 1.0
    overall_safety_score: float = 1.0
    composite_score: float = 0.0
    has_unconfirmed_legs: bool = False
    route_status: RouteStatus = RouteStatus.CONFIRMED


@dataclass(slots=True)
class TripResult:
    """Final result returned to the API layer."""

    options: list[TripObject] = field(default_factory=list)
    origin_resolved: str | None = None  # node_id
    destination_resolved: str | None = None  # node_id
    destination_nearest_node: str | None = None  # for villages
    routing_warnings: list[str] = field(default_factory=list)
    query_duration_ms: float = 0.0


@dataclass(frozen=True, slots=True)
class SearchInput:
    """Validated search request from the API layer."""

    origin_lat: float
    origin_lng: float
    destination_lat: float
    destination_lng: float
    departure_date: date
    origin_label: str = ""
    destination_label: str = ""
    priority: RoutePriority = RoutePriority.BALANCED
    max_transfers: int = 3
    exclude_modes: list[TransportMode] = field(default_factory=list)
