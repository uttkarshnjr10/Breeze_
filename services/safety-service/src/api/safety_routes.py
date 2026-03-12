"""
Breeze Safety Intelligence — FastAPI Routes.
Prefix: /api/v1

GET  /safety/pulse/{node_id}     — L1 → Redis → compute fresh
POST /safety/reviews             — validate, save, publish Kafka event
GET  /safety/alerts/{node_id}    — lightweight alerts array
GET  /health/ready               — 503 until NLP models loaded
"""

from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1")


# ── Request / Response Schemas ────────────────────────────────

class ReviewCreateRequest(BaseModel):
    transit_node_id: str
    user_id: str
    text: str = Field(min_length=10, max_length=5000)
    helpful_votes: int = 0
    is_verified: bool = False


class ReviewCreateResponse(BaseModel):
    review_id: str
    status: str = "submitted"


class SafetyPulseResponse(BaseModel):
    node_id: str
    score: float
    level: str
    total_reviews: int
    filtered_reviews: int
    confidence: str
    alerts: list[dict]
    computed_at: str


class HealthResponse(BaseModel):
    status: str
    service: str = "safety-service"
    models_loaded: bool = False


# ── Routes ────────────────────────────────────────────────────

@router.get("/safety/pulse/{node_id}")
async def get_safety_pulse(node_id: str, request: Request):
    """
    Get Safety Pulse for a transit node.
    L1 cache → Redis cache → compute fresh from reviews.
    """
    aggregator = request.app.state.aggregator
    review_repo = request.app.state.review_repo

    reviews = await review_repo.get_reviews_for_node(node_id)
    pulse = await aggregator.get_pulse(node_id, reviews)

    return pulse


@router.post("/safety/reviews", response_model=ReviewCreateResponse)
async def create_review(body: ReviewCreateRequest, request: Request):
    """
    Submit a safety review.
    Validates → saves to MongoDB → publishes 'review.submitted' Kafka event.
    """
    review_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc)
    trace_id = f"safety-{review_id[:8]}-{int(now.timestamp())}"

    # Save to MongoDB
    review_repo = request.app.state.review_repo
    review_data = {
        "review_id": review_id,
        "transit_node_id": body.transit_node_id,
        "user_id": body.user_id,
        "text": body.text,
        "helpful_votes": body.helpful_votes,
        "is_verified": body.is_verified,
        "created_at": now,
    }
    await review_repo.create_review(review_data)

    # Publish Kafka event
    kafka_producer = request.app.state.kafka_producer
    if kafka_producer is not None:
        try:
            await kafka_producer.send_and_wait(
                "breeze.review.submitted",
                key=review_id.encode(),
                value=json.dumps({
                    "review_id": review_id,
                    "transit_node_id": body.transit_node_id,
                    "user_id": body.user_id,
                    "text": body.text,
                    "helpful_votes": body.helpful_votes,
                    "is_verified": body.is_verified,
                    "created_at": now.isoformat(),
                }).encode(),
                headers=[
                    ("x-trace-id", trace_id.encode()),
                    ("x-produced-at", now.isoformat().encode()),
                ],
            )
        except Exception as exc:
            logger.error("Failed to publish Kafka event: %s", exc)
            # Don't fail the request — review is already in MongoDB.
            # Kafka consumer will pick it up via reconciliation.

    return ReviewCreateResponse(review_id=review_id)


@router.get("/safety/alerts/{node_id}")
async def get_safety_alerts(node_id: str, request: Request):
    """
    Get alerts array only (lightweight widget).
    Uses the cached pulse — no full recomputation.
    """
    aggregator = request.app.state.aggregator
    review_repo = request.app.state.review_repo

    reviews = await review_repo.get_reviews_for_node(node_id)
    pulse = await aggregator.get_pulse(node_id, reviews)

    return {"node_id": node_id, "alerts": pulse.get("alerts", [])}


# ── Health Routes ─────────────────────────────────────────────

health_router = APIRouter()


@health_router.get("/health/live")
async def health_live():
    return {"status": "ok", "service": "safety-service"}


@health_router.get("/health/ready")
async def health_ready(request: Request):
    """Returns 503 until all NLP models are loaded."""
    pipeline = request.app.state.nlp_pipeline

    if not pipeline.is_ready:
        raise HTTPException(
            status_code=503,
            detail="NLP models not loaded yet",
        )

    return HealthResponse(
        status="ready",
        models_loaded=True,
    )
