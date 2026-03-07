"""
Breeze TripGraph — Pydantic request/response schemas for the API layer.
Strict validation. No untyped dicts cross the API boundary.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from enum import Enum

from pydantic import BaseModel, Field, field_validator


# ─── Enums (API-level mirrors) ──────────────────────────────────

class TransportModeApi(str, Enum):
    TRAIN = "TRAIN"
    FLIGHT = "FLIGHT"
    BUS = "BUS"
    AUTO = "AUTO"
    CAB = "CAB"
    METRO = "METRO"
    E_RICKSHAW = "E_RICKSHAW"
    WALK = "WALK"


class RoutePriorityApi(str, Enum):
    FASTEST = "FASTEST"
    CHEAPEST = "CHEAPEST"
    SAFEST = "SAFEST"
    BALANCED = "BALANCED"


class RouteStatusApi(str, Enum):
    CONFIRMED = "CONFIRMED"
    PARTIAL = "PARTIAL"
    UNCONFIRMED = "UNCONFIRMED"


class LegTypeApi(str, Enum):
    ANCHOR = "ANCHOR"
    FIRST_MILE = "FIRST_MILE"
    LAST_MILE = "LAST_MILE"
    LOCAL_CONNECTOR = "LOCAL_CONNECTOR"


# ─── Request Schemas ────────────────────────────────────────────

class SearchPreferences(BaseModel):
    max_transfers: int = Field(default=3, ge=0, le=10)
    exclude_modes: list[TransportModeApi] = Field(default_factory=list)


class SearchRoutesRequest(BaseModel):
    origin_lat: float = Field(..., ge=-90, le=90)
    origin_lng: float = Field(..., ge=-180, le=180)
    origin_label: str = ""
    destination_lat: float = Field(..., ge=-90, le=90)
    destination_lng: float = Field(..., ge=-180, le=180)
    destination_label: str = ""
    departure_date: date
    priority: RoutePriorityApi = RoutePriorityApi.BALANCED
    preferences: SearchPreferences = Field(default_factory=SearchPreferences)

    @field_validator("departure_date")
    @classmethod
    def validate_departure_date(cls, v: date) -> date:
        from datetime import date as date_type
        if v < date_type.today():
            raise ValueError("departure_date cannot be in the past")
        return v


class SaveTripSegmentRequest(BaseModel):
    leg_type: LegTypeApi
    transport_mode: TransportModeApi
    from_node_id: str
    to_node_id: str
    departure_time: str | None = None
    arrival_time: str | None = None
    duration_minutes: int
    cost_inr: str
    safety_score: float = 0.8
    confidence: float = 0.9
    external_id: str | None = None
    source: str = ""
    is_anchor: bool = False


class SaveTripRequest(BaseModel):
    origin_node_id: str
    destination_node_id: str
    destination_village_name: str | None = None
    departure_date: date
    priority: RoutePriorityApi = RoutePriorityApi.BALANCED
    total_estimated_cost: str | None = None
    total_duration_minutes: int | None = None
    overall_confidence: float | None = None
    route_status: RouteStatusApi = RouteStatusApi.CONFIRMED
    has_unconfirmed_legs: bool = False
    idempotency_key: str | None = None
    segments: list[SaveTripSegmentRequest]


# ─── Response Schemas ───────────────────────────────────────────

class SegmentResponse(BaseModel):
    from_node_id: str
    to_node_id: str
    mode: str
    leg_type: str
    duration_minutes: int
    cost_inr: str
    safety_score: float
    confidence: float
    source: str
    departure_time: str | None = None
    arrival_time: str | None = None
    external_id: str | None = None
    distance_km: float = 0.0
    note: str | None = None


class TripOptionResponse(BaseModel):
    trip_id: str
    segments: list[SegmentResponse]
    total_duration_minutes: int
    total_cost_inr: str
    anchor_segment_index: int
    overall_confidence: float
    overall_safety_score: float
    composite_score: float
    has_unconfirmed_legs: bool
    route_status: str


class SearchRoutesResponse(BaseModel):
    options: list[TripOptionResponse]
    origin_resolved: str | None = None
    destination_resolved: str | None = None
    destination_nearest_node: str | None = None
    routing_warnings: list[str] = Field(default_factory=list)
    query_duration_ms: float = 0.0


class SaveTripResponse(BaseModel):
    trip_id: str
    status: str = "saved"


class HealthResponse(BaseModel):
    status: str
    service: str = "tripgraph-service"
    graph_nodes: int = 0
