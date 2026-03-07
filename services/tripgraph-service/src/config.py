"""
Breeze TripGraph Service — Configuration.
Pydantic BaseSettings: validates all env vars at startup.
"""

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Service configuration loaded from environment variables."""

    # ── Database (via PgBouncer) ──────────────────────────────
    database_url: str = "postgresql://breeze:breeze_dev_secret@localhost:6432/breeze_dev"
    db_pool_min: int = 5
    db_pool_max: int = 20

    # ── Redis ─────────────────────────────────────────────────
    redis_url: str = "redis://localhost:6379"

    # ── Kafka ─────────────────────────────────────────────────
    kafka_brokers: str = "localhost:9092"

    # ── gRPC (Auth Service) ───────────────────────────────────
    auth_grpc_host: str = "localhost"
    auth_grpc_port: int = 50051

    # ── Downstream HTTP services ──────────────────────────────
    transit_service_url: str = "http://localhost:3003"
    safety_service_url: str = "http://localhost:3004"
    flock_service_url: str = "http://localhost:3005"

    # ── Server ────────────────────────────────────────────────
    http_port: int = 3002
    node_env: str = "development"

    # ── Routing ───────────────────────────────────────────────
    graph_refresh_interval_hours: int = 6
    route_cache_ttl_seconds: int = 900  # 15 minutes

    model_config = {"env_prefix": "TRIPGRAPH_", "case_sensitive": False}


settings = Settings()
