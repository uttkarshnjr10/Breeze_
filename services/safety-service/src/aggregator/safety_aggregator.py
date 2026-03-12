"""
Breeze Safety Intelligence — Safety Pulse Aggregator.
Computes time-decaying safety scores (0.0-5.0) per transit node.
L1 TTLCache (200 entries, 60s) → Redis → compute fresh.
"""

from __future__ import annotations

import json
import logging
import math
from collections import Counter
from datetime import datetime, timedelta, timezone

import redis.asyncio as aioredis
from cachetools import TTLCache

from src.config import settings
from src.pipeline.models import (
    CRIME_SEVERITY,
    SEVERITY_WEIGHTS,
    CrimeType,
    SafetyAlert,
    SafetyLevel,
    SafetyPulse,
    Severity,
)

logger = logging.getLogger(__name__)


class SafetyPulseAggregator:
    """
    Computes Safety Pulse scores from community reviews.
    L1 in-process TTLCache → Redis → compute fresh from review data.
    """

    def __init__(self, redis_client: aioredis.Redis) -> None:
        self._redis = redis_client
        # L1 cache: 200 entries, 60 second TTL
        self._l1_cache: TTLCache[str, dict] = TTLCache(maxsize=200, ttl=60)

    async def get_pulse(
        self,
        node_id: str,
        reviews: list[dict],
        node_metadata: dict | None = None,
    ) -> dict:
        """
        Get Safety Pulse for a node.
        L1 → Redis → compute fresh.
        """
        # ── L1 Cache ──────────────────────────────────────
        cached = self._l1_cache.get(node_id)
        if cached is not None:
            return cached

        # ── Redis Cache ───────────────────────────────────
        redis_key = f"safety:pulse:{node_id}"
        redis_cached = await self._redis.get(redis_key)
        if redis_cached is not None:
            pulse = json.loads(redis_cached)
            self._l1_cache[node_id] = pulse
            return pulse

        # ── Compute Fresh ─────────────────────────────────
        pulse = self.compute_pulse(reviews, node_id, node_metadata or {})

        # Cache both layers
        serialized = json.dumps(pulse)
        await self._redis.setex(
            redis_key, settings.pulse_cache_ttl_seconds, serialized,
        )
        self._l1_cache[node_id] = pulse

        return pulse

    def compute_pulse(
        self,
        reviews: list[dict],
        node_id: str,
        node_metadata: dict,
    ) -> dict:
        """
        Compute Safety Pulse from raw reviews.
        a. Filter: non-rejected, age <= 180 days.
        b. Time-decay weight: exp(-0.03 * days) * log1p(helpful_votes).
        c. Weighted sentiment average → base_score (0.0-5.0).
        d. Crime entity penalty.
        e. Clamp final score.
        f. Determine level + alerts + confidence.
        """
        now = datetime.now(timezone.utc)
        cutoff = now - timedelta(days=180)

        # ── a. Filter ─────────────────────────────────────
        filtered: list[dict] = []
        for review in reviews:
            # Skip moderation-rejected reviews
            if review.get("moderation_rejected", False):
                continue

            created = review.get("created_at")
            if isinstance(created, str):
                created = datetime.fromisoformat(created)
            if created and created.tzinfo is None:
                created = created.replace(tzinfo=timezone.utc)
            if created and created < cutoff:
                continue

            filtered.append(review)

        total_reviews = len(reviews)
        filtered_count = len(filtered)

        if filtered_count == 0:
            return self._default_pulse(node_id, total_reviews)

        # ── b. Time-decay weights ─────────────────────────
        weighted_sentiments: list[tuple[float, float]] = []
        crime_entity_map: dict[str, list[dict]] = {}

        for review in filtered:
            created = review.get("created_at")
            if isinstance(created, str):
                created = datetime.fromisoformat(created)
            if created and created.tzinfo is None:
                created = created.replace(tzinfo=timezone.utc)

            days_old = max(0, (now - created).days) if created else 0
            helpful_votes = max(1, int(review.get("helpful_votes", 0)))

            # decay = exp(-0.03 * days_old)
            decay = math.exp(-0.03 * days_old)
            weight = decay * math.log1p(helpful_votes)

            # Sentiment → numeric score (0.0-5.0 scale)
            sentiment = review.get("sentiment_label", "neutral")
            if sentiment == "positive":
                sentiment_score = 4.5
            elif sentiment == "negative":
                sentiment_score = 1.5
            else:
                sentiment_score = 3.0

            weighted_sentiments.append((sentiment_score, weight))

            # Collect crime entities
            entities = review.get("entities", [])
            for entity in entities:
                crime_type = entity.get("crime_type", "unknown")
                if crime_type not in crime_entity_map:
                    crime_entity_map[crime_type] = []
                crime_entity_map[crime_type].append({
                    "weight": weight,
                    "location_context": entity.get("location_context"),
                    "time_context": entity.get("time_context"),
                    "severity": entity.get("severity", "medium"),
                })

        # ── c. Weighted sentiment average → base_score ────
        total_weight = sum(w for _, w in weighted_sentiments)
        if total_weight > 0:
            base_score = sum(s * w for s, w in weighted_sentiments) / total_weight
        else:
            base_score = 3.0

        # ── d. Crime entity penalty ───────────────────────
        total_penalty = 0.0
        for crime_type_str, occurrences in crime_entity_map.items():
            try:
                severity = Severity(occurrences[0].get("severity", "medium"))
            except ValueError:
                severity = Severity.MEDIUM

            severity_weight = SEVERITY_WEIGHTS[severity]
            count = len(occurrences)
            avg_weight = sum(o["weight"] for o in occurrences) / count

            # penalty = severity_weight * min(1.0, count/10) * avg_weight
            penalty = severity_weight * min(1.0, count / 10) * avg_weight
            total_penalty += penalty

        # ── e. Final score ────────────────────────────────
        final_score = max(0.0, min(5.0, base_score - total_penalty))

        # ── f. Level ──────────────────────────────────────
        if final_score >= 4.0:
            level = SafetyLevel.SAFE
        elif final_score >= 3.0:
            level = SafetyLevel.CAUTION
        elif final_score >= 2.0:
            level = SafetyLevel.WARNING
        else:
            level = SafetyLevel.DANGER

        # ── g. Alerts ─────────────────────────────────────
        alerts = self._build_alerts(crime_entity_map)

        # ── h. Confidence ─────────────────────────────────
        if filtered_count >= 20:
            confidence = "high"
        elif filtered_count >= 5:
            confidence = "medium"
        elif filtered_count > 0:
            confidence = "low"
        else:
            confidence = "none"

        return {
            "node_id": node_id,
            "score": round(final_score, 2),
            "level": level.value,
            "total_reviews": total_reviews,
            "filtered_reviews": filtered_count,
            "confidence": confidence,
            "alerts": alerts,
            "computed_at": now.isoformat(),
        }

    def _build_alerts(self, crime_entity_map: dict[str, list[dict]]) -> list[dict]:
        """Build alerts from crime entity map (most common location + time)."""
        alerts: list[dict] = []

        for crime_type_str, occurrences in crime_entity_map.items():
            count = len(occurrences)
            if count == 0:
                continue

            # Most common location context
            locations = [
                o["location_context"] for o in occurrences
                if o.get("location_context")
            ]
            most_common_location = (
                Counter(locations).most_common(1)[0][0] if locations else None
            )

            # Most common time context
            times = [
                o["time_context"] for o in occurrences
                if o.get("time_context")
            ]
            most_common_time = (
                Counter(times).most_common(1)[0][0] if times else None
            )

            try:
                severity = Severity(occurrences[0].get("severity", "medium"))
            except ValueError:
                severity = Severity.MEDIUM

            alerts.append({
                "crime_type": crime_type_str,
                "severity": severity.value,
                "count": count,
                "most_common_location": most_common_location,
                "most_common_time": most_common_time,
            })

        # Sort by count descending
        alerts.sort(key=lambda a: a["count"], reverse=True)
        return alerts

    def _default_pulse(self, node_id: str, total_reviews: int = 0) -> dict:
        """Default pulse when no reviews are available."""
        return {
            "node_id": node_id,
            "score": 3.0,
            "level": SafetyLevel.CAUTION.value,
            "total_reviews": total_reviews,
            "filtered_reviews": 0,
            "confidence": "none",
            "alerts": [],
            "computed_at": datetime.now(timezone.utc).isoformat(),
        }

    def invalidate(self, node_id: str) -> None:
        """Invalidate L1 cache for a node. Called on high-severity events."""
        self._l1_cache.pop(node_id, None)

    async def invalidate_all(self, node_id: str) -> None:
        """Invalidate both L1 and Redis cache for a node."""
        self._l1_cache.pop(node_id, None)
        await self._redis.delete(f"safety:pulse:{node_id}")
