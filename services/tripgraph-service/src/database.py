"""
Breeze TripGraph Service — Database connection pool.
Uses asyncpg connected to PgBouncer (port 6432).
"""

from __future__ import annotations

import asyncpg
from asyncpg import Pool

from src.config import settings

_pool: Pool | None = None


async def get_pool() -> Pool:
    """Get or create the asyncpg connection pool."""
    global _pool
    if _pool is None:
        _pool = await asyncpg.create_pool(
            dsn=settings.database_url,
            min_size=settings.db_pool_min,
            max_size=settings.db_pool_max,
            command_timeout=30,
        )
    return _pool


async def close_pool() -> None:
    """Close the asyncpg connection pool."""
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None
