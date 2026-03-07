"""
Breeze TripGraph Service — FastAPI Application.
Entrypoint: gunicorn -k uvicorn.workers.UvicornWorker -w 4 src.main:app

Startup: Redis → asyncpg → GraphStore → APScheduler → Kafka consumer.
Shutdown: Kafka → scheduler → DB pool → Redis (reverse order).
"""

from __future__ import annotations

import asyncio
import json
import logging

import redis.asyncio as aioredis
from aiokafka import AIOKafkaConsumer, AIOKafkaProducer
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from fastapi import FastAPI

from src.api.routes import health_router, router
from src.config import settings
from src.database import close_pool, get_pool
from src.delay.domino_engine import DominoEngine
from src.graph.graph_store import GraphStore
from src.orchestrator.route_orchestrator import RouteOrchestrator

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)
logger = logging.getLogger(__name__)

# ─── Application Factory ───────────────────────────────────────

app = FastAPI(
    title="Breeze TripGraph Service",
    description="AI-powered multi-modal routing engine for India",
    version="0.1.0",
    docs_url="/docs" if settings.node_env != "production" else None,
    redoc_url=None,
)

# Mount routers
app.include_router(router)
app.include_router(health_router)

# ─── Startup ───────────────────────────────────────────────────


@app.on_event("startup")
async def startup() -> None:
    """Initialize all service dependencies in order."""
    logger.info("TripGraph Service starting...")

    # 1. Redis
    redis_client = aioredis.from_url(settings.redis_url, decode_responses=True)
    app.state.redis = redis_client
    logger.info("Redis connected: %s", settings.redis_url)

    # 2. Database pool (via PgBouncer)
    pool = await get_pool()
    logger.info("Database pool created: min=%d, max=%d", settings.db_pool_min, settings.db_pool_max)

    # 3. GraphStore — load transit network
    graph_store = GraphStore()
    await graph_store.initialize()
    app.state.graph_store = graph_store
    logger.info("GraphStore ready: %d nodes", graph_store.node_count)

    # 4. Route Orchestrator
    orchestrator = RouteOrchestrator(graph_store, redis_client)
    app.state.orchestrator = orchestrator

    # 5. APScheduler — refresh GraphStore every N hours
    scheduler = AsyncIOScheduler()
    scheduler.add_job(
        graph_store.refresh,
        "interval",
        hours=settings.graph_refresh_interval_hours,
        id="graph_refresh",
    )
    scheduler.start()
    app.state.scheduler = scheduler
    logger.info(
        "APScheduler started: GraphStore refresh every %dh",
        settings.graph_refresh_interval_hours,
    )

    # 6. Kafka producer (for DominoEngine)
    kafka_producer = AIOKafkaProducer(
        bootstrap_servers=settings.kafka_brokers,
        client_id="tripgraph-producer",
    )
    await kafka_producer.start()
    app.state.kafka_producer = kafka_producer

    # 7. Kafka consumer (for delay events)
    kafka_consumer = AIOKafkaConsumer(
        "breeze.train.delay.detected",
        bootstrap_servers=settings.kafka_brokers,
        group_id="tripgraph-domino",
        auto_offset_reset="latest",
    )
    await kafka_consumer.start()
    app.state.kafka_consumer = kafka_consumer

    # 8. DominoEngine
    domino_engine = DominoEngine(redis_client, kafka_producer)
    app.state.domino_engine = domino_engine

    # 9. Start delay consumer loop (background task)
    app.state.delay_task = asyncio.create_task(
        _consume_delay_events(kafka_consumer, domino_engine),
    )

    logger.info("TripGraph Service ready — listening on port %d", settings.http_port)


# ─── Shutdown ──────────────────────────────────────────────────


@app.on_event("shutdown")
async def shutdown() -> None:
    """Graceful shutdown in reverse initialization order."""
    logger.info("TripGraph Service shutting down...")

    # Cancel delay consumer background task
    delay_task = getattr(app.state, "delay_task", None)
    if delay_task:
        delay_task.cancel()
        try:
            await delay_task
        except asyncio.CancelledError:
            pass

    # Kafka consumer
    consumer = getattr(app.state, "kafka_consumer", None)
    if consumer:
        await consumer.stop()
        logger.info("Kafka consumer stopped")

    # Kafka producer
    producer = getattr(app.state, "kafka_producer", None)
    if producer:
        await producer.stop()
        logger.info("Kafka producer stopped")

    # Scheduler
    scheduler = getattr(app.state, "scheduler", None)
    if scheduler:
        scheduler.shutdown(wait=False)
        logger.info("APScheduler stopped")

    # Database pool
    await close_pool()
    logger.info("Database pool closed")

    # Redis
    redis_client = getattr(app.state, "redis", None)
    if redis_client:
        await redis_client.close()
        logger.info("Redis disconnected")

    logger.info("TripGraph Service shutdown complete")


# ─── Kafka Delay Consumer Loop ─────────────────────────────────


async def _consume_delay_events(
    consumer: AIOKafkaConsumer,
    domino_engine: DominoEngine,
) -> None:
    """Background task: continuously consume delay events from Kafka."""
    logger.info("Delay event consumer started")

    try:
        async for message in consumer:
            try:
                event_data = json.loads(message.value.decode())
                event_key = message.key.decode() if message.key else ""

                await domino_engine.process_delay_event(event_data, event_key)

            except Exception as exc:
                logger.error("Failed to process delay event: %s", exc, exc_info=True)

    except asyncio.CancelledError:
        logger.info("Delay event consumer cancelled")
    except Exception as exc:
        logger.error("Delay consumer crashed: %s", exc, exc_info=True)
