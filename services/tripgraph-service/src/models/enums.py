"""
Breeze TripGraph — Enumerations.
All domain enums. TransportMode includes a mode_hierarchy for anchor detection.
"""

from __future__ import annotations

from enum import Enum, IntEnum


class NodeType(str, Enum):
    """Transit node types in the Indian transport network."""

    RAILWAY_STATION = "RAILWAY_STATION"
    BUS_STAND = "BUS_STAND"
    AIRPORT = "AIRPORT"
    METRO_STATION = "METRO_STATION"
    ROAD_JUNCTION = "ROAD_JUNCTION"


class TransportMode(str, Enum):
    """Transport modes supported by the routing engine."""

    TRAIN = "TRAIN"
    FLIGHT = "FLIGHT"
    BUS = "BUS"
    AUTO = "AUTO"
    CAB = "CAB"
    METRO = "METRO"
    E_RICKSHAW = "E_RICKSHAW"
    WALK = "WALK"


class ModeHierarchy(IntEnum):
    """
    Mode hierarchy for anchor leg detection.
    Higher value = higher priority for anchor assignment.
    """

    WALK = 0
    E_RICKSHAW = 1
    AUTO = 1
    CAB = 1
    METRO = 2
    BUS = 3
    TRAIN = 4
    FLIGHT = 5


# Mapping from TransportMode to hierarchy level
MODE_HIERARCHY: dict[TransportMode, int] = {
    TransportMode.WALK: ModeHierarchy.WALK,
    TransportMode.E_RICKSHAW: ModeHierarchy.E_RICKSHAW,
    TransportMode.AUTO: ModeHierarchy.AUTO,
    TransportMode.CAB: ModeHierarchy.CAB,
    TransportMode.METRO: ModeHierarchy.METRO,
    TransportMode.BUS: ModeHierarchy.BUS,
    TransportMode.TRAIN: ModeHierarchy.TRAIN,
    TransportMode.FLIGHT: ModeHierarchy.FLIGHT,
}


class LegType(str, Enum):
    """Segment role within a multi-leg trip."""

    ANCHOR = "ANCHOR"
    FIRST_MILE = "FIRST_MILE"
    LAST_MILE = "LAST_MILE"
    LOCAL_CONNECTOR = "LOCAL_CONNECTOR"


class RoutePriority(str, Enum):
    """User preference for route ranking."""

    FASTEST = "FASTEST"
    CHEAPEST = "CHEAPEST"
    SAFEST = "SAFEST"
    BALANCED = "BALANCED"


class RouteStatus(str, Enum):
    """Confidence status of a route."""

    CONFIRMED = "CONFIRMED"
    PARTIAL = "PARTIAL"
    UNCONFIRMED = "UNCONFIRMED"


# ── Transfer buffer minutes (from_mode → to_mode → minutes) ──

TRANSFER_BUFFERS: dict[tuple[TransportMode, TransportMode], int] = {
    (TransportMode.TRAIN, TransportMode.TRAIN): 45,
    (TransportMode.TRAIN, TransportMode.FLIGHT): 90,
    (TransportMode.FLIGHT, TransportMode.TRAIN): 90,
    (TransportMode.FLIGHT, TransportMode.FLIGHT): 120,
    (TransportMode.BUS, TransportMode.TRAIN): 30,
    (TransportMode.TRAIN, TransportMode.BUS): 30,
    (TransportMode.BUS, TransportMode.BUS): 20,
}

DEFAULT_TRANSFER_BUFFER_MINUTES: int = 20


def get_transfer_buffer(from_mode: TransportMode, to_mode: TransportMode) -> int:
    """Get transfer buffer minutes between two transport modes."""
    return TRANSFER_BUFFERS.get((from_mode, to_mode), DEFAULT_TRANSFER_BUFFER_MINUTES)
