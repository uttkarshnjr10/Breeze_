"""
Breeze Safety Intelligence — Elasticsearch Repository.
Async elasticsearch-py client. Index: safety_reviews.
review_id as document _id → natural idempotency (overwrite on re-index).
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from elasticsearch import AsyncElasticsearch

from src.config import settings

logger = logging.getLogger(__name__)

# ── Index Mapping ──────────────────────────────────────────────

REVIEW_INDEX_MAPPING = {
    "mappings": {
        "properties": {
            "review_id": {"type": "keyword"},
            "transit_node_id": {"type": "keyword"},
            "user_id": {"type": "keyword"},
            "created_at": {"type": "date"},
            "text": {"type": "text", "analyzer": "standard"},
            "language": {"type": "keyword"},
            "is_toxic": {"type": "boolean"},
            "moderation_rejected": {"type": "boolean"},
            "toxicity_score": {"type": "float"},
            "sentiment_label": {"type": "keyword"},
            "sentiment_confidence": {"type": "float"},
            "entities": {
                "type": "nested",
                "properties": {
                    "crime_type": {"type": "keyword"},
                    "severity": {"type": "keyword"},
                    "confidence": {"type": "float"},
                    "location_context": {"type": "keyword"},
                    "time_context": {"type": "keyword"},
                },
            },
            "helpful_votes": {"type": "integer"},
            "is_verified": {"type": "boolean"},
        },
    },
    "settings": {
        "number_of_shards": 1,
        "number_of_replicas": 0,
    },
}


class ElasticsearchRepository:
    """Async Elasticsearch repository for safety reviews."""

    def __init__(self, client: AsyncElasticsearch) -> None:
        self._client = client
        self._index = settings.elasticsearch_index

    async def ensure_index(self) -> None:
        """Create the index if it doesn't exist. Idempotent."""
        exists = await self._client.indices.exists(index=self._index)
        if not exists:
            await self._client.indices.create(
                index=self._index,
                body=REVIEW_INDEX_MAPPING,
            )
            logger.info("ElasticsearchRepository: index '%s' created", self._index)
        else:
            logger.info("ElasticsearchRepository: index '%s' already exists", self._index)

    async def index_review(self, review: dict) -> None:
        """
        Index a review document.
        Uses review_id as document _id → natural idempotency.
        Same review indexed twice = overwrite, no duplicate.
        """
        review_id = review.get("review_id", "")
        await self._client.index(
            index=self._index,
            id=review_id,  # document _id = review_id
            document=review,
        )

    async def get_reviews_for_aggregation(
        self,
        node_id: str,
        since_days: int = 180,
    ) -> list[dict]:
        """
        Get reviews for pulse aggregation.
        Term filter on transit_node_id + date range.
        """
        cutoff = datetime.now(timezone.utc) - timedelta(days=since_days)

        result = await self._client.search(
            index=self._index,
            body={
                "size": 500,
                "query": {
                    "bool": {
                        "filter": [
                            {"term": {"transit_node_id": node_id}},
                            {"range": {"created_at": {"gte": cutoff.isoformat()}}},
                        ],
                    },
                },
                "sort": [{"created_at": {"order": "desc"}}],
            },
        )

        return [hit["_source"] for hit in result["hits"]["hits"]]

    async def delete_review(self, review_id: str) -> None:
        """Soft-delete support: remove a review from the index."""
        try:
            await self._client.delete(index=self._index, id=review_id)
        except Exception as exc:
            logger.warning("ES delete failed for review %s: %s", review_id, exc)
