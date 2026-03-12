"""
Breeze Safety Intelligence — Kafka Review Consumer.
Consumer group: 'safety-service'.
Topic: 'review.submitted'.

Pipeline: extract trace-id → idempotency check (Redis SETNX 24hr) →
          NLP pipeline → update MongoDB → index Elasticsearch →
          recompute Safety Pulse → invalidate cache on high-severity.

On failure: log error, commit offset anyway. Nightly reconciliation catches missed reviews.
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone

import redis.asyncio as aioredis
from aiokafka import AIOKafkaConsumer

from src.aggregator.safety_aggregator import SafetyPulseAggregator
from src.config import settings
from src.pipeline.models import Severity
from src.pipeline.nlp_pipeline import SafetyNLPPipeline
from src.repositories.elasticsearch_repository import ElasticsearchRepository
from src.repositories.review_repository import ReviewRepository

logger = logging.getLogger(__name__)

IDEMPOTENCY_TTL = 86400  # 24 hours


class ReviewConsumer:
    """
    Kafka consumer for review.submitted events.
    Runs as a background asyncio task.
    """

    def __init__(
        self,
        nlp_pipeline: SafetyNLPPipeline,
        review_repo: ReviewRepository,
        es_repo: ElasticsearchRepository,
        aggregator: SafetyPulseAggregator,
        redis_client: aioredis.Redis,
    ) -> None:
        self._pipeline = nlp_pipeline
        self._review_repo = review_repo
        self._es_repo = es_repo
        self._aggregator = aggregator
        self._redis = redis_client
        self._consumer: AIOKafkaConsumer | None = None
        self._running = False

    async def start(self) -> None:
        """Start the Kafka consumer loop."""
        self._consumer = AIOKafkaConsumer(
            "breeze.review.submitted",
            bootstrap_servers=settings.kafka_brokers,
            group_id="safety-service",
            auto_offset_reset="latest",
            value_deserializer=lambda v: json.loads(v.decode()),
        )
        await self._consumer.start()
        self._running = True
        logger.info("ReviewConsumer: started listening on review.submitted")

    async def stop(self) -> None:
        """Graceful stop."""
        self._running = False
        if self._consumer:
            await self._consumer.stop()
        logger.info("ReviewConsumer: stopped")

    async def consume_loop(self) -> None:
        """Main consume loop — runs as a background task."""
        if not self._consumer:
            raise RuntimeError("Consumer not started")

        try:
            async for message in self._consumer:
                if not self._running:
                    break

                try:
                    await self._process_message(message)
                except Exception as exc:
                    # Log error, commit offset anyway — don't block the consumer.
                    # Nightly reconciliation handles missed reviews.
                    logger.error(
                        "ReviewConsumer: failed to process message: %s",
                        exc, exc_info=True,
                    )

        except asyncio.CancelledError:
            logger.info("ReviewConsumer: loop cancelled")
        except Exception as exc:
            logger.error("ReviewConsumer: loop crashed: %s", exc, exc_info=True)

    async def _process_message(self, message) -> None:
        """Process a single Kafka message through the full pipeline."""
        data = message.value
        review_id = data.get("review_id", "")
        text = data.get("text", "")
        node_id = data.get("transit_node_id", "")

        # ── a. Extract trace ID from headers ──────────────
        trace_id = ""
        if message.headers:
            for key, value in message.headers:
                if key == "x-trace-id":
                    trace_id = value.decode() if value else ""

        logger.info(
            "ReviewConsumer: processing review %s for node %s [trace:%s]",
            review_id, node_id, trace_id,
        )

        # ── b. Idempotency check ──────────────────────────
        idem_key = f"processed:{review_id}"
        was_set = await self._redis.set(idem_key, "1", ex=IDEMPOTENCY_TTL, nx=True)
        if not was_set:
            logger.info("ReviewConsumer: skipping duplicate review %s", review_id)
            return

        # ── c. Run NLP pipeline ───────────────────────────
        result = await self._pipeline.process(review_id, text)

        # ── d. Update MongoDB with AI fields ──────────────
        await self._review_repo.update_review_ai_fields(review_id, result)

        # ── e. Index into Elasticsearch ───────────────────
        review_doc = {
            "review_id": review_id,
            "transit_node_id": node_id,
            "text": text,
            "user_id": data.get("user_id", ""),
            "created_at": data.get("created_at", datetime.now(timezone.utc).isoformat()),
            "language": result.language,
            "is_toxic": result.is_toxic,
            "moderation_rejected": result.moderation_rejected,
            "toxicity_score": result.toxicity_score,
            "sentiment_label": result.sentiment_label.value,
            "sentiment_confidence": result.sentiment_confidence,
            "entities": [
                {
                    "crime_type": e.crime_type.value,
                    "severity": e.severity.value,
                    "confidence": e.confidence,
                    "location_context": e.location_context,
                    "time_context": e.time_context,
                }
                for e in result.entities
            ],
            "helpful_votes": data.get("helpful_votes", 0),
            "is_verified": data.get("is_verified", False),
        }
        await self._es_repo.index_review(review_doc)

        # ── f. Recompute Safety Pulse ─────────────────────
        if node_id:
            reviews = await self._review_repo.get_reviews_for_node(node_id)
            await self._aggregator.get_pulse(node_id, reviews)

        # ── g. High-severity → immediate cache invalidation
        has_high_severity = any(
            e.severity == Severity.HIGH for e in result.entities
        )
        if has_high_severity and node_id:
            await self._aggregator.invalidate_all(node_id)
            logger.warning(
                "ReviewConsumer: HIGH severity entity detected for node %s — cache invalidated",
                node_id,
            )

        logger.info(
            "ReviewConsumer: completed review %s — sentiment=%s, entities=%d, toxic=%s",
            review_id, result.sentiment_label.value, len(result.entities), result.is_toxic,
        )
