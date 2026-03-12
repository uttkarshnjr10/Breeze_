"""
Breeze Safety Intelligence Service — Configuration.
Pydantic Settings validated from environment variables.
"""

from __future__ import annotations

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Service configuration. All fields have dev-friendly defaults."""

    # ── Server ─────────────────────────────────────────────
    node_env: str = "development"
    http_port: int = 3004
    gunicorn_workers: int = 2  # 2 workers × ~1.1GB models = ~2.2GB RAM

    # ── MongoDB ────────────────────────────────────────────
    mongo_url: str = "mongodb://localhost:27017"
    mongo_db: str = "breeze_safety"

    # ── Elasticsearch ──────────────────────────────────────
    elasticsearch_url: str = "http://localhost:9200"
    elasticsearch_index: str = "safety_reviews"

    # ── Redis ──────────────────────────────────────────────
    redis_url: str = "redis://localhost:6379"
    pulse_cache_ttl_seconds: int = 300  # 5 minutes

    # ── Kafka ──────────────────────────────────────────────
    kafka_brokers: str = "localhost:9092"

    # ── NLP Model Paths (baked into Docker image) ──────────
    model_base_path: str = "/models"
    fasttext_model_path: str = "/models/lid.176.ftz"
    toxicity_model_path: str = "/models/toxicity"
    sentiment_model_path: str = "/models/sentiment"
    ner_model_path: str = "/models/ner"

    # ── Pipeline ───────────────────────────────────────────
    nlp_thread_pool_workers: int = 4  # CPU-bound, match physical cores
    toxicity_threshold: float = 0.75

    model_config = {"env_prefix": "SAFETY_", "case_sensitive": False}


settings = Settings()
