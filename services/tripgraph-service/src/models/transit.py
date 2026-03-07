"""
Breeze TripGraph — Transit data models.
Frozen dataclasses for immutability across async tasks.
TransitNode, Connection (CSA), TransportEdge (demand).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal

from src.models.enums import NodeType, TransportMode


@dataclass(frozen=True, slots=True)
class TransitNode:
    """A node in the Indian transit network (station, airport, junction)."""

    id: str
    name: str
    lat: float
    lng: float
    node_type: NodeType
    station_code: str | None = None
    city: str | None = None
    state: str | None = None
    is_verified: bool = True


@dataclass(frozen=True, slots=True)
class Connection:
    """
    A single timetable entry for CSA (Connection Scan Algorithm).
    Represents one train/flight/bus on one specific day.
    All datetime objects must be timezone-aware (Asia/Kolkata → UTC internally).
    """

    from_node_id: str
    to_node_id: str
    departure_time: datetime  # timezone-aware
    arrival_time: datetime  # timezone-aware
    mode: TransportMode
    external_id: str  # train number, flight number
    cost_inr: Decimal
    safety_score: float = 0.8
    confidence: float = 0.9
    source: str = "irctc"


@dataclass(frozen=True, slots=True)
class TransportEdge:
    """
    An on-demand transport option (no departure time).
    Used by the DemandRouter for AUTO, CAB, WALK, E_RICKSHAW, METRO.
    """

    from_node_id: str
    to_node_id: str
    mode: TransportMode
    duration_minutes: int
    cost_inr: Decimal
    safety_score: float = 0.7
    confidence: float = 0.6
    source: str = "flock"
