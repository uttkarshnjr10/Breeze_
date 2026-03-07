"""
Breeze TripGraph — Delay Domino Engine.
Kafka consumer for 'train.delay.detected' events.
Cascades delay impact through affected trips using Critical Path Method (CPM).
Emits 'trip.reroute.needed' for trips with missed connections.
Idempotent via Redis key: domino-processed:{event_key} (1hr TTL).
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta

import redis.asyncio as aioredis
from aiokafka import AIOKafkaConsumer, AIOKafkaProducer

from src.config import settings
from src.database import get_pool
from src.models.enums import get_transfer_buffer, TransportMode

logger = logging.getLogger(__name__)

# Idempotency key TTL (seconds)
IDEMPOTENCY_TTL = 3600  # 1 hour


@dataclass
class DominoImpact:
    """Impact analysis for a single trip's segment."""

    segment_id: str
    segment_order: int
    original_departure: datetime
    original_arrival: datetime
    cascaded_delay_minutes: int
    connection_missed: bool
    slack_absorbed_minutes: int = 0


@dataclass
class TripImpact:
    """Aggregated impact on a full trip."""

    trip_id: str
    user_id: str
    impacts: list[DominoImpact]
    total_cascaded_delay: int
    missed_connections: int
    needs_reroute: bool


class DominoEngine:
    """
    Consumes train.delay.detected Kafka events.
    For each delayed segment:
      1. Find all trips with that external_id.
      2. Cascade delay through subsequent segments (CPM).
      3. Identify missed connections.
      4. Emit trip.reroute.needed for affected trips.
    """

    def __init__(
        self,
        redis_client: aioredis.Redis,
        kafka_producer: AIOKafkaProducer,
    ) -> None:
        self._redis = redis_client
        self._producer = kafka_producer

    async def process_delay_event(self, event_data: dict, event_key: str) -> None:
        """
        Process a single delay event.
        Idempotent: skips if already processed (Redis check).
        """
        # ── Idempotency check ─────────────────────────────────
        idem_key = f"domino-processed:{event_key}"
        already_processed = await self._redis.get(idem_key)
        if already_processed:
            logger.info("Domino: skipping duplicate event %s", event_key)
            return

        external_id = event_data.get("external_id", "")
        delay_minutes = int(event_data.get("delay_minutes", 0))
        trace_id = event_data.get("trace_id", "")

        if not external_id or delay_minutes <= 0:
            logger.warning("Domino: invalid event data: %s", event_data)
            return

        logger.info(
            "Domino: processing delay — %s delayed %d minutes",
            external_id, delay_minutes,
        )

        # ── Find affected trips ───────────────────────────────
        pool = await get_pool()

        affected_trips = await pool.fetch(
            """
            SELECT DISTINCT t.id AS trip_id, t.user_id
            FROM trips t
            JOIN trip_segments ts ON ts.trip_id = t.id
            WHERE ts.external_id = $1
              AND t.status IN ('PLANNED', 'ACTIVE')
            """,
            external_id,
        )

        if not affected_trips:
            logger.info("Domino: no active trips use %s", external_id)
            await self._redis.setex(idem_key, IDEMPOTENCY_TTL, "1")
            return

        # ── Cascade through each trip ─────────────────────────
        for trip_row in affected_trips:
            trip_id = str(trip_row["trip_id"])
            user_id = str(trip_row["user_id"])

            impact = await self._cascade_delay(
                trip_id=trip_id,
                user_id=user_id,
                delayed_external_id=external_id,
                delay_minutes=delay_minutes,
            )

            if impact and impact.needs_reroute:
                await self._emit_reroute_event(impact, trace_id)
                logger.warning(
                    "Domino: trip %s needs reroute — %d missed connections, %dmin cascaded",
                    trip_id, impact.missed_connections, impact.total_cascaded_delay,
                )

        # ── Mark as processed ─────────────────────────────────
        await self._redis.setex(idem_key, IDEMPOTENCY_TTL, "1")

    async def _cascade_delay(
        self,
        trip_id: str,
        user_id: str,
        delayed_external_id: str,
        delay_minutes: int,
    ) -> TripImpact | None:
        """
        Cascade a delay through all segments after the delayed one.
        Uses CPM: checks if slack between segments absorbs the cascaded delay.
        """
        pool = await get_pool()

        segments = await pool.fetch(
            """
            SELECT id, segment_order, transport_mode, external_id,
                   departure_time, arrival_time, duration_minutes
            FROM trip_segments
            WHERE trip_id = $1
            ORDER BY segment_order
            """,
            trip_id,
        )

        if not segments:
            return None

        # Find the index of the delayed segment
        delayed_idx: int | None = None
        for i, seg in enumerate(segments):
            if seg["external_id"] == delayed_external_id:
                delayed_idx = i
                break

        if delayed_idx is None:
            return None

        # ── CPM cascade ───────────────────────────────────────
        impacts: list[DominoImpact] = []
        cascaded_delay = delay_minutes
        missed_count = 0

        for i in range(delayed_idx + 1, len(segments)):
            seg = segments[i]
            prev_seg = segments[i - 1]

            if prev_seg["arrival_time"] is None or seg["departure_time"] is None:
                continue

            # Effective arrival of previous = scheduled + cascaded delay
            effective_prev_arrival = prev_seg["arrival_time"] + timedelta(
                minutes=cascaded_delay,
            )

            # Transfer buffer
            prev_mode = TransportMode(prev_seg["transport_mode"])
            curr_mode = TransportMode(seg["transport_mode"])
            buffer = get_transfer_buffer(prev_mode, curr_mode)

            # Safe departure window end
            safe_departure = seg["departure_time"] - timedelta(minutes=buffer)

            if effective_prev_arrival > safe_departure:
                # Connection missed
                connection_missed = True
                missed_count += 1
                # New cascaded delay = how late we'd arrive vs scheduled arrival
                cascaded_delay = int(
                    (effective_prev_arrival - seg["arrival_time"]).total_seconds() / 60
                )
            else:
                # Slack absorbed
                connection_missed = False
                slack = int(
                    (safe_departure - effective_prev_arrival).total_seconds() / 60
                )
                cascaded_delay = max(0, cascaded_delay - slack)

            impacts.append(DominoImpact(
                segment_id=str(seg["id"]),
                segment_order=seg["segment_order"],
                original_departure=seg["departure_time"],
                original_arrival=seg["arrival_time"],
                cascaded_delay_minutes=cascaded_delay,
                connection_missed=connection_missed,
                slack_absorbed_minutes=0 if connection_missed else slack,
            ))

        return TripImpact(
            trip_id=trip_id,
            user_id=user_id,
            impacts=impacts,
            total_cascaded_delay=cascaded_delay,
            missed_connections=missed_count,
            needs_reroute=missed_count > 0,
        )

    async def _emit_reroute_event(
        self, impact: TripImpact, trace_id: str,
    ) -> None:
        """Emit trip.reroute.needed Kafka event."""
        await self._producer.send(
            "breeze.trip.reroute.needed",
            key=impact.trip_id.encode(),
            value=json.dumps({
                "trip_id": impact.trip_id,
                "user_id": impact.user_id,
                "total_cascaded_delay_minutes": impact.total_cascaded_delay,
                "missed_connections": impact.missed_connections,
                "impacts": [
                    {
                        "segment_id": imp.segment_id,
                        "segment_order": imp.segment_order,
                        "cascaded_delay_minutes": imp.cascaded_delay_minutes,
                        "connection_missed": imp.connection_missed,
                    }
                    for imp in impact.impacts
                ],
            }).encode(),
            headers=[
                ("x-trace-id", trace_id.encode() if trace_id else b""),
                ("x-produced-at", datetime.utcnow().isoformat().encode()),
            ],
        )
