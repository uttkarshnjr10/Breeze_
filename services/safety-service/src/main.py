"""
Breeze Safety Intelligence Service — FastAPI Application.
Gunicorn runtime: gunicorn -k uvicorn.workers.UvicornWorker -w 2 src.main:app

Startup: MongoDB → Redis → Elasticsearch → NLP Pipeline → Kafka →
         ReviewConsumer → Routes.
Shutdown: Consumer → Kafka → ES → MongoDB → Redis (reverse).

Readiness: /health/ready returns 503 until NLP models loaded.
"""

from __future__ import annotations

import asyncio
import logging

import redis.asyncio as aioredis
from aiokafka import AIOKafkaProducer, AIOKafkaConsumer
from elasticsearch import AsyncElasticsearch
from fastapi import FastAPI
from motor.motor_asyncio import AsyncIOMotorClient

from src.aggregator.safety_aggregator import SafetyPulseAggregator
from src.api.safety_routes import health_router, router
from src.config import settings
from src.consumers.review_consumer import ReviewConsumer
from src.pipeline.nlp_pipeline import SafetyNLPPipeline
from src.repositories.elasticsearch_repository import ElasticsearchRepository
from src.repositories.review_repository import ReviewRepository

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

# ── Application ────────────────────────────────────────────────

app = FastAPI(
    title="Breeze Safety Intelligence Service",
    version="0.1.0",
    description="NLP pipeline + Safety Pulse scoring for transit safety reviews",
)

app.include_router(router)
app.include_router(health_router)


# ── Lifecycle ──────────────────────────────────────────────────

@app.on_event("startup")
async def startup() -> None:
    logger.info("Safety Intelligence Service starting...")

    # 1. MongoDB
    mongo_client = AsyncIOMotorClient(settings.mongo_url)
    app.state.mongo_client = mongo_client
    review_repo = ReviewRepository(mongo_client)
    await review_repo.ensure_indexes()
    app.state.review_repo = review_repo
    logger.info("MongoDB connected, indexes ensured")

    # 2. Redis
    redis_client = aioredis.from_url(settings.redis_url, decode_responses=True)
    await redis_client.ping()
    app.state.redis_client = redis_client
    logger.info("Redis connected")

    # 3. Elasticsearch
    es_client = AsyncElasticsearch(settings.elasticsearch_url)
    es_repo = ElasticsearchRepository(es_client)
    await es_repo.ensure_index()
    app.state.es_client = es_client
    app.state.es_repo = es_repo
    logger.info("Elasticsearch connected, index ensured")

    # 4. Safety Pulse Aggregator
    aggregator = SafetyPulseAggregator(redis_client)
    app.state.aggregator = aggregator

    # 5. NLP Pipeline (models loaded in ThreadPoolExecutor)
    nlp_pipeline = SafetyNLPPipeline()
    app.state.nlp_pipeline = nlp_pipeline
    try:
        await nlp_pipeline.initialize()
        logger.info("NLP pipeline initialized — all models loaded")
    except FileNotFoundError as exc:
        logger.error(
            "NLP Pipeline failed to load: %s. "
            "Service will start but /health/ready will return 503.",
            exc,
        )

    # 6. Kafka Producer
    try:
        kafka_producer = AIOKafkaProducer(
            bootstrap_servers=settings.kafka_brokers,
        )
        await kafka_producer.start()
        app.state.kafka_producer = kafka_producer
        logger.info("Kafka producer connected")
    except Exception as exc:
        logger.warning("Kafka producer failed to start: %s", exc)
        app.state.kafka_producer = None

    # 7. Kafka Consumer (background task)
    consumer = ReviewConsumer(
        nlp_pipeline=nlp_pipeline,
        review_repo=review_repo,
        es_repo=es_repo,
        aggregator=aggregator,
        redis_client=aioredis.from_url(settings.redis_url),
    )
    app.state.review_consumer = consumer
    try:
        await consumer.start()
        app.state.consumer_task = asyncio.create_task(consumer.consume_loop())
        logger.info("Review consumer started")
    except Exception as exc:
        logger.warning("Review consumer failed to start: %s", exc)
        app.state.consumer_task = None

    logger.info("Safety Intelligence Service started on port %d", settings.http_port)


@app.on_event("shutdown")
async def shutdown() -> None:
    logger.info("Safety Intelligence Service shutting down...")

    # 1. Cancel consumer task
    consumer_task = getattr(app.state, "consumer_task", None)
    if consumer_task:
        consumer_task.cancel()
        try:
            await consumer_task
        except asyncio.CancelledError:
            pass

    # 2. Stop consumer
    consumer = getattr(app.state, "review_consumer", None)
    if consumer:
        await consumer.stop()

    # 3. Kafka producer
    producer = getattr(app.state, "kafka_producer", None)
    if producer:
        await producer.stop()
        logger.info("Kafka producer disconnected")

    # 4. Elasticsearch
    es_client = getattr(app.state, "es_client", None)
    if es_client:
        await es_client.close()
        logger.info("Elasticsearch disconnected")

    # 5. MongoDB
    mongo_client = getattr(app.state, "mongo_client", None)
    if mongo_client:
        mongo_client.close()
        logger.info("MongoDB disconnected")

    # 6. Redis
    redis_client = getattr(app.state, "redis_client", None)
    if redis_client:
        await redis_client.close()
        logger.info("Redis disconnected")

    logger.info("Safety Intelligence Service shutdown complete")
