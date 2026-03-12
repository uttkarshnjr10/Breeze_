"""
Breeze Safety Intelligence — MongoDB Review Repository.
Motor async client. Indexes: {transit_node_id: 1, created_at: -1}, {user_id: 1}.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorDatabase

from src.config import settings
from src.pipeline.models import PipelineResult

logger = logging.getLogger(__name__)


class ReviewRepository:
    """Async MongoDB repository for safety reviews."""

    def __init__(self, client: AsyncIOMotorClient) -> None:
        self._db: AsyncIOMotorDatabase = client[settings.mongo_db]
        self._collection = self._db["safety_reviews"]

    async def ensure_indexes(self) -> None:
        """Create indexes on startup. Idempotent."""
        await self._collection.create_index(
            [("transit_node_id", 1), ("created_at", -1)],
            name="idx_node_created",
        )
        await self._collection.create_index(
            [("user_id", 1)],
            name="idx_user",
        )
        logger.info("ReviewRepository: indexes ensured")

    async def create_review(self, data: dict) -> dict:
        """Insert a new review document."""
        data["created_at"] = data.get(
            "created_at", datetime.now(timezone.utc),
        )
        result = await self._collection.insert_one(data)
        data["_id"] = str(result.inserted_id)
        return data

    async def get_reviews_for_node(
        self,
        node_id: str,
        since_days: int = 180,
    ) -> list[dict]:
        """
        Get reviews for a transit node within the time window.
        Used by the aggregator for pulse computation.
        """
        cutoff = datetime.now(timezone.utc) - timedelta(days=since_days)
        cursor = self._collection.find(
            {
                "transit_node_id": node_id,
                "created_at": {"$gte": cutoff},
            },
            {
                "_id": 0,
                "review_id": 1,
                "transit_node_id": 1,
                "text": 1,
                "created_at": 1,
                "sentiment_label": 1,
                "entities": 1,
                "moderation_rejected": 1,
                "helpful_votes": 1,
                "is_verified": 1,
            },
        ).sort("created_at", -1)

        return await cursor.to_list(length=500)

    async def update_review_ai_fields(
        self,
        review_id: str,
        result: PipelineResult,
    ) -> None:
        """
        Update a review document with AI pipeline results.
        Upserts — handles both existing and new reviews.
        """
        update = {
            "$set": {
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
                "processed_at": result.processed_at,
            },
        }

        await self._collection.update_one(
            {"review_id": review_id},
            update,
            upsert=True,
        )

    async def get_review(self, review_id: str) -> Optional[dict]:
        """Get a single review by ID."""
        return await self._collection.find_one(
            {"review_id": review_id}, {"_id": 0},
        )
