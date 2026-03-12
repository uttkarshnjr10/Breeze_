"""
Breeze Safety Intelligence — NLP Pipeline Data Models.
Frozen dataclasses for pipeline stage outputs.
Enums for CrimeType, Severity, SafetyLevel.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Optional


# ── Enums ─────────────────────────────────────────────────────

class CrimeType(str, Enum):
    MOBILE_SNATCHING = "mobile_snatching"
    CHAIN_SNATCHING = "chain_snatching"
    PICKPOCKET = "pickpocket"
    ASSAULT = "assault"
    HARASSMENT = "harassment"
    THEFT = "theft"
    POOR_LIGHTING = "poor_lighting"
    OVERCROWDING = "overcrowding"


class Severity(str, Enum):
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"


class SafetyLevel(str, Enum):
    SAFE = "SAFE"         # score >= 4.0
    CAUTION = "CAUTION"   # score >= 3.0
    WARNING = "WARNING"   # score >= 2.0
    DANGER = "DANGER"     # score < 2.0


class SentimentLabel(str, Enum):
    POSITIVE = "positive"
    NEUTRAL = "neutral"
    NEGATIVE = "negative"


# ── Severity weights for crime penalty calculation ────────────

SEVERITY_WEIGHTS: dict[Severity, float] = {
    Severity.HIGH: 0.8,
    Severity.MEDIUM: 0.4,
    Severity.LOW: 0.1,
}

# ── Crime type → default severity mapping ─────────────────────

CRIME_SEVERITY: dict[CrimeType, Severity] = {
    CrimeType.MOBILE_SNATCHING: Severity.HIGH,
    CrimeType.CHAIN_SNATCHING: Severity.HIGH,
    CrimeType.ASSAULT: Severity.HIGH,
    CrimeType.HARASSMENT: Severity.HIGH,
    CrimeType.PICKPOCKET: Severity.MEDIUM,
    CrimeType.THEFT: Severity.MEDIUM,
    CrimeType.POOR_LIGHTING: Severity.LOW,
    CrimeType.OVERCROWDING: Severity.LOW,
}


# ── Data Classes ──────────────────────────────────────────────

@dataclass(frozen=True)
class ExtractedEntity:
    """A single crime entity extracted from review text."""

    crime_type: CrimeType
    severity: Severity
    confidence: float  # 0.0-1.0
    location_context: Optional[str] = None  # platform_1, exit_gate, etc.
    time_context: Optional[str] = None      # night, morning, peak_hours


@dataclass(frozen=True)
class PipelineResult:
    """Output of the full 5-stage NLP pipeline."""

    review_id: str
    language: str                          # 'en', 'hi', etc.
    is_toxic: bool                         # toxicity >= threshold
    moderation_rejected: bool              # if toxic, reject
    toxicity_score: float                  # 0.0-1.0
    sentiment_label: SentimentLabel
    sentiment_confidence: float            # 0.0-1.0
    entities: tuple[ExtractedEntity, ...]  # frozen tuple of entities
    processed_at: datetime = field(default_factory=datetime.utcnow)


@dataclass(frozen=True)
class SafetyAlert:
    """A structured alert derived from aggregated crime entities."""

    crime_type: CrimeType
    severity: Severity
    count: int
    most_common_location: Optional[str] = None
    most_common_time: Optional[str] = None


@dataclass(frozen=True)
class SafetyPulse:
    """The final Safety Pulse score for a transit node."""

    node_id: str
    score: float           # 0.0-5.0
    level: SafetyLevel
    total_reviews: int
    filtered_reviews: int  # after moderation + age filter
    confidence: str        # 'high', 'medium', 'low', 'none'
    alerts: tuple[SafetyAlert, ...]
    computed_at: datetime = field(default_factory=datetime.utcnow)
