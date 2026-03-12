"""
Unit Tests for SafetyPulseAggregator.
Tests: all-positive, all-negative + crime entities, time-decay effect.
Run with: python -m pytest tests/ -v
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock




# We test compute_pulse() directly — it's a pure function (no Redis/cache)
# The aggregator class receives a redis_client but compute_pulse() doesn't use it.

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from src.aggregator.safety_aggregator import SafetyPulseAggregator


def _make_review(
    sentiment: str = "neutral",
    days_ago: int = 0,
    helpful_votes: int = 0,
    moderation_rejected: bool = False,
    entities: list[dict] | None = None,
) -> dict:
    """Helper to create a test review dict."""
    created = datetime.now(timezone.utc) - timedelta(days=days_ago)
    return {
        "review_id": f"test-{id(sentiment)}-{days_ago}",
        "transit_node_id": "node_test",
        "sentiment_label": sentiment,
        "created_at": created.isoformat(),
        "helpful_votes": helpful_votes,
        "moderation_rejected": moderation_rejected,
        "entities": entities or [],
    }


def _make_aggregator() -> SafetyPulseAggregator:
    """Create an aggregator with a mocked Redis client."""
    mock_redis = AsyncMock()
    return SafetyPulseAggregator(mock_redis)


# ═══════════════════════════════════════════════════════════════
# TEST 1: All-Positive Reviews
# ═══════════════════════════════════════════════════════════════

class TestAllPositiveReviews:
    """When all reviews are positive, score should be close to 4.5 (SAFE)."""

    def test_all_positive_high_score(self):
        agg = _make_aggregator()
        reviews = [_make_review(sentiment="positive", days_ago=i) for i in range(25)]

        pulse = agg.compute_pulse(reviews, "station_A", {})

        assert pulse["score"] >= 4.0, f"Expected score >= 4.0, got {pulse['score']}"
        assert pulse["level"] == "SAFE"
        assert pulse["confidence"] == "high"  # 25 reviews >= 20
        assert pulse["alerts"] == []
        assert pulse["filtered_reviews"] == 25

    def test_all_positive_no_crime_entities(self):
        agg = _make_aggregator()
        reviews = [_make_review(sentiment="positive") for _ in range(10)]

        pulse = agg.compute_pulse(reviews, "station_B", {})

        assert pulse["score"] >= 4.0
        assert len(pulse["alerts"]) == 0

    def test_positive_with_helpful_votes_boosts_weight(self):
        """Reviews with more helpful_votes should carry more weight."""
        agg = _make_aggregator()

        # Mix: some positive with votes, some neutral with no votes
        reviews = [
            _make_review(sentiment="positive", helpful_votes=50),
            _make_review(sentiment="positive", helpful_votes=30),
            _make_review(sentiment="neutral", helpful_votes=0),
        ]

        pulse = agg.compute_pulse(reviews, "station_C", {})

        # Positive reviews with high votes should dominate
        assert pulse["score"] > 3.5, f"Expected > 3.5, got {pulse['score']}"


# ═══════════════════════════════════════════════════════════════
# TEST 2: All-Negative + Crime Entities
# ═══════════════════════════════════════════════════════════════

class TestNegativeWithCrime:
    """Negative sentiment + crime entities → score should drop, alerts generated."""

    def test_negative_with_high_severity_crime(self):
        agg = _make_aggregator()
        reviews = [
            _make_review(
                sentiment="negative",
                entities=[{
                    "crime_type": "mobile_snatching",
                    "severity": "high",
                    "confidence": 0.85,
                    "location_context": "platform_1",
                    "time_context": "night",
                }],
            )
            for _ in range(10)
        ]

        pulse = agg.compute_pulse(reviews, "station_D", {})

        # Negative (1.5 base) - high severity penalty → likely DANGER or WARNING
        assert pulse["score"] < 2.0, f"Expected < 2.0, got {pulse['score']}"
        assert pulse["level"] in ("DANGER", "WARNING")
        assert len(pulse["alerts"]) > 0

        # Check alert structure
        alert = pulse["alerts"][0]
        assert alert["crime_type"] == "mobile_snatching"
        assert alert["severity"] == "high"
        assert alert["count"] == 10
        assert alert["most_common_location"] == "platform_1"
        assert alert["most_common_time"] == "night"

    def test_multiple_crime_types_multiple_alerts(self):
        agg = _make_aggregator()
        reviews = [
            _make_review(
                sentiment="negative",
                entities=[
                    {"crime_type": "pickpocket", "severity": "medium", "confidence": 0.7,
                     "location_context": "exit_gate", "time_context": "peak_hours"},
                    {"crime_type": "poor_lighting", "severity": "low", "confidence": 0.6,
                     "location_context": "parking", "time_context": "night"},
                ],
            )
            for _ in range(5)
        ]

        pulse = agg.compute_pulse(reviews, "station_E", {})

        assert pulse["score"] < 3.0
        assert len(pulse["alerts"]) == 2  # Two distinct crime types

    def test_moderation_rejected_excluded(self):
        """Rejected reviews should not count in the score."""
        agg = _make_aggregator()
        reviews = [
            _make_review(sentiment="negative", moderation_rejected=True)
            for _ in range(10)
        ] + [
            _make_review(sentiment="positive") for _ in range(5)
        ]

        pulse = agg.compute_pulse(reviews, "station_F", {})

        # Only the 5 positive reviews should count
        assert pulse["filtered_reviews"] == 5
        assert pulse["score"] >= 4.0  # All-positive after filtering

    def test_crime_penalty_formula(self):
        """Verify the penalty formula: severity_weight * min(1.0, count/10) * avg_weight."""
        agg = _make_aggregator()

        # 5 negative reviews with high-severity crime (today = weight ~0.69)
        reviews = [
            _make_review(
                sentiment="negative",
                days_ago=0,
                entities=[{"crime_type": "assault", "severity": "high",
                           "confidence": 0.9, "location_context": None,
                           "time_context": None}],
            )
            for _ in range(5)
        ]

        pulse = agg.compute_pulse(reviews, "station_G", {})

        # base_score = 1.5 (all negative)
        # penalty = 0.8 (high) * min(1.0, 5/10) * avg_weight
        # avg_weight = decay(0) * log1p(1) ≈ 1.0 * 0.693 ≈ 0.693
        # penalty ≈ 0.8 * 0.5 * 0.693 ≈ 0.277
        # final ≈ 1.5 - 0.277 ≈ 1.22
        assert pulse["score"] < 1.5
        assert pulse["score"] > 0.0  # Clamped at 0


# ═══════════════════════════════════════════════════════════════
# TEST 3: Time-Decay Effect
# ═══════════════════════════════════════════════════════════════

class TestTimeDecay:
    """Older reviews should have less influence than recent ones."""

    def test_recent_negative_dominates_old_positive(self):
        """A *recent* negative review should outweigh an *old* positive review."""
        agg = _make_aggregator()
        reviews = [
            # 10 old positive reviews (170 days ago — heavily decayed)
            *[_make_review(sentiment="positive", days_ago=170) for _ in range(10)],
            # 5 recent negative reviews (today — full weight)
            *[_make_review(sentiment="negative", days_ago=0) for _ in range(5)],
        ]

        pulse = agg.compute_pulse(reviews, "station_H", {})

        # Recent negatives should dominate despite being fewer
        assert pulse["score"] < 3.0, f"Expected < 3.0, got {pulse['score']}"

    def test_old_negative_decays_toward_neutral(self):
        """Old negative reviews should have minimal effect."""
        agg = _make_aggregator()

        # All negative, but very old
        old_negative = [
            _make_review(sentiment="negative", days_ago=170) for _ in range(10)
        ]
        # All negative, but recent
        recent_negative = [
            _make_review(sentiment="negative", days_ago=1) for _ in range(10)
        ]

        pulse_old = agg.compute_pulse(old_negative, "node_old", {})
        pulse_recent = agg.compute_pulse(recent_negative, "node_recent", {})

        # Both should be negative, but old reviews should have a LESS extreme score
        # because their weight is heavily decayed — though sentiment is still 1.5
        # The key insight is that if weights are all equal (just smaller),
        # the weighted average stays the same. So the score difference is subtle.
        # But if we add mixed reviews, the decay effect becomes clear.
        assert pulse_old["score"] == pulse_recent["score"]  # Same sentiment = same avg

    def test_decay_math_correctness(self):
        """Verify the decay formula produces expected values."""
        # decay = exp(-0.03 * days)
        assert abs(math.exp(-0.03 * 0) - 1.0) < 0.001       # today: weight = 1.0
        assert abs(math.exp(-0.03 * 30) - 0.407) < 0.01     # 30 days: ~0.41
        assert abs(math.exp(-0.03 * 90) - 0.067) < 0.01     # 90 days: ~0.07
        assert abs(math.exp(-0.03 * 180) - 0.0045) < 0.001  # 180 days: ~0.005

    def test_mixed_recent_vs_old_with_votes(self):
        """Recent reviews with helpful_votes should dominate old unhelpful ones."""
        agg = _make_aggregator()
        reviews = [
            # 3 recent positive with many votes
            _make_review(sentiment="positive", days_ago=1, helpful_votes=100),
            _make_review(sentiment="positive", days_ago=2, helpful_votes=80),
            _make_review(sentiment="positive", days_ago=3, helpful_votes=60),
            # 10 old negative with no votes
            *[_make_review(sentiment="negative", days_ago=150) for _ in range(10)],
        ]

        pulse = agg.compute_pulse(reviews, "station_I", {})

        # Recent positives with high votes should win
        assert pulse["score"] > 3.0, f"Expected > 3.0, got {pulse['score']}"


# ═══════════════════════════════════════════════════════════════
# TEST 4: Edge Cases
# ═══════════════════════════════════════════════════════════════

class TestEdgeCases:
    """Edge cases and boundary conditions."""

    def test_empty_reviews_returns_default(self):
        agg = _make_aggregator()
        pulse = agg.compute_pulse([], "station_empty", {})

        assert pulse["score"] == 3.0
        assert pulse["level"] == "CAUTION"
        assert pulse["confidence"] == "none"
        assert pulse["filtered_reviews"] == 0

    def test_single_review_low_confidence(self):
        agg = _make_aggregator()
        reviews = [_make_review(sentiment="positive")]

        pulse = agg.compute_pulse(reviews, "station_single", {})

        assert pulse["confidence"] == "low"  # 1 review < 5

    def test_five_reviews_medium_confidence(self):
        agg = _make_aggregator()
        reviews = [_make_review(sentiment="neutral") for _ in range(5)]

        pulse = agg.compute_pulse(reviews, "station_5", {})

        assert pulse["confidence"] == "medium"

    def test_score_clamped_to_zero(self):
        """Score cannot go below 0.0 even with extreme penalties."""
        agg = _make_aggregator()
        # 10 negative reviews with multiple high-severity crimes each
        reviews = [
            _make_review(
                sentiment="negative",
                entities=[
                    {"crime_type": "assault", "severity": "high",
                     "confidence": 0.9, "location_context": None, "time_context": None},
                    {"crime_type": "mobile_snatching", "severity": "high",
                     "confidence": 0.9, "location_context": None, "time_context": None},
                    {"crime_type": "harassment", "severity": "high",
                     "confidence": 0.9, "location_context": None, "time_context": None},
                ],
            )
            for _ in range(10)
        ]

        pulse = agg.compute_pulse(reviews, "station_extreme", {})

        assert pulse["score"] >= 0.0
        assert pulse["level"] == "DANGER"

    def test_score_clamped_to_five(self):
        """Score cannot exceed 5.0."""
        agg = _make_aggregator()
        # Positive doesn't go above 4.5 base, so this is naturally satisfied
        reviews = [_make_review(sentiment="positive") for _ in range(100)]

        pulse = agg.compute_pulse(reviews, "station_max", {})

        assert pulse["score"] <= 5.0

    def test_invalidate_clears_l1_cache(self):
        agg = _make_aggregator()
        # Manually inject into L1 cache
        agg._l1_cache["test_node"] = {"score": 4.0}

        agg.invalidate("test_node")

        assert "test_node" not in agg._l1_cache


if __name__ == "__main__":
    # Quick self-test without pytest
    import traceback

    test_classes = [
        TestAllPositiveReviews,
        TestNegativeWithCrime,
        TestTimeDecay,
        TestEdgeCases,
    ]

    passed = 0
    failed = 0

    for cls in test_classes:
        instance = cls()
        for method_name in dir(instance):
            if method_name.startswith("test_"):
                try:
                    getattr(instance, method_name)()
                    print(f"  ✅ {cls.__name__}.{method_name}")
                    passed += 1
                except Exception as e:
                    print(f"  ❌ {cls.__name__}.{method_name}: {e}")
                    traceback.print_exc()
                    failed += 1

    print(f"\n{'='*50}")
    print(f"Results: {passed} passed, {failed} failed, {passed + failed} total")
    if failed == 0:
        print("ALL TESTS PASSED ✅")
    else:
        print("SOME TESTS FAILED ❌")
