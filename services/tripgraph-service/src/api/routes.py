"""
Breeze TripGraph — FastAPI routes.
All routes prefixed /api/v1.
POST /routes/search, POST /routes/save, GET /trips/{trip_id},
GET /trips/{trip_id}/reroute, GET /health/live, GET /health/ready.
"""

from __future__ import annotations

import logging
import uuid
from datetime import date, datetime
from decimal import Decimal

from fastapi import APIRouter, Header, HTTPException, Request

from src.api.schemas import (
    HealthResponse,
    SaveTripRequest,
    SaveTripResponse,
    SearchRoutesRequest,
    SearchRoutesResponse,
    SegmentResponse,
    TripOptionResponse,
)
from src.database import get_pool
from src.models.enums import RoutePriority, TransportMode
from src.models.trip import SearchInput

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1")


# ─── POST /routes/search ───────────────────────────────────────

@router.post("/routes/search", response_model=SearchRoutesResponse)
async def search_routes(
    body: SearchRoutesRequest,
    request: Request,
    idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
) -> SearchRoutesResponse:
    """
    Search for multi-modal routes between two locations.
    Idempotency-Key supported (24hr TTL).
    """
    orchestrator = request.app.state.orchestrator
    redis_client = request.app.state.redis

    # Idempotency check
    if idempotency_key:
        cached = await redis_client.get(f"idem:search:{idempotency_key}")
        if cached:
            import json
            return SearchRoutesResponse(**json.loads(cached))

    # Convert API types to domain types
    exclude_modes = [TransportMode(m.value) for m in body.preferences.exclude_modes]

    search_input = SearchInput(
        origin_lat=body.origin_lat,
        origin_lng=body.origin_lng,
        destination_lat=body.destination_lat,
        destination_lng=body.destination_lng,
        departure_date=body.departure_date,
        origin_label=body.origin_label,
        destination_label=body.destination_label,
        priority=RoutePriority(body.priority.value),
        max_transfers=body.preferences.max_transfers,
        exclude_modes=exclude_modes,
    )

    result = await orchestrator.search(search_input)

    # Build response
    response = SearchRoutesResponse(
        options=[
            TripOptionResponse(
                trip_id=t.trip_id,
                segments=[
                    SegmentResponse(
                        from_node_id=s.from_node_id,
                        to_node_id=s.to_node_id,
                        mode=s.mode.value,
                        leg_type=s.leg_type.value,
                        duration_minutes=s.duration_minutes,
                        cost_inr=str(s.cost_inr),
                        safety_score=s.safety_score,
                        confidence=s.confidence,
                        source=s.source,
                        departure_time=(
                            s.departure_time.isoformat() if s.departure_time else None
                        ),
                        arrival_time=(
                            s.arrival_time.isoformat() if s.arrival_time else None
                        ),
                        external_id=s.external_id,
                        distance_km=s.distance_km,
                        note=s.note,
                    )
                    for s in t.segments
                ],
                total_duration_minutes=t.total_duration_minutes,
                total_cost_inr=str(t.total_cost_inr),
                anchor_segment_index=t.anchor_segment_index,
                overall_confidence=t.overall_confidence,
                overall_safety_score=t.overall_safety_score,
                composite_score=t.composite_score,
                has_unconfirmed_legs=t.has_unconfirmed_legs,
                route_status=t.route_status.value,
            )
            for t in result.options
        ],
        origin_resolved=result.origin_resolved,
        destination_resolved=result.destination_resolved,
        destination_nearest_node=result.destination_nearest_node,
        routing_warnings=result.routing_warnings,
        query_duration_ms=result.query_duration_ms,
    )

    # Cache idempotency response
    if idempotency_key:
        import json
        await redis_client.setex(
            f"idem:search:{idempotency_key}",
            86400,  # 24hr TTL
            json.dumps(response.model_dump()),
        )

    return response


# ─── POST /routes/save ─────────────────────────────────────────

@router.post("/routes/save", response_model=SaveTripResponse)
async def save_trip(
    body: SaveTripRequest,
    request: Request,
) -> SaveTripResponse:
    """
    Save a route as a trip.
    Saves to trips + trip_segments in a single transaction.
    """
    pool = await get_pool()

    # Idempotency: check if trip with this key already exists
    if body.idempotency_key:
        existing = await pool.fetchrow(
            "SELECT id FROM trips WHERE idempotency_key = $1",
            body.idempotency_key,
        )
        if existing:
            return SaveTripResponse(trip_id=str(existing["id"]))

    trip_id = str(uuid.uuid4())

    async with pool.acquire() as conn:
        async with conn.transaction():
            # Insert trip
            await conn.execute(
                """
                INSERT INTO trips (
                    id, user_id, origin_node_id, destination_node_id,
                    destination_village_name, departure_date, priority,
                    total_estimated_cost, total_duration_minutes,
                    overall_confidence, route_status, has_unconfirmed_legs,
                    idempotency_key
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
                """,
                uuid.UUID(trip_id),
                uuid.UUID("00000000-0000-0000-0000-000000000000"),  # placeholder user
                body.origin_node_id,
                body.destination_node_id,
                body.destination_village_name,
                body.departure_date,
                body.priority.value,
                Decimal(body.total_estimated_cost) if body.total_estimated_cost else None,
                body.total_duration_minutes,
                body.overall_confidence,
                body.route_status.value,
                body.has_unconfirmed_legs,
                body.idempotency_key,
            )

            # Insert segments
            for i, seg in enumerate(body.segments):
                await conn.execute(
                    """
                    INSERT INTO trip_segments (
                        trip_id, segment_order, leg_type, transport_mode,
                        from_node_id, to_node_id, departure_time, arrival_time,
                        duration_minutes, cost_inr, safety_score, confidence,
                        external_id, source, is_anchor
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
                    """,
                    uuid.UUID(trip_id),
                    i,
                    seg.leg_type.value,
                    seg.transport_mode.value,
                    seg.from_node_id,
                    seg.to_node_id,
                    datetime.fromisoformat(seg.departure_time) if seg.departure_time else None,
                    datetime.fromisoformat(seg.arrival_time) if seg.arrival_time else None,
                    seg.duration_minutes,
                    Decimal(seg.cost_inr),
                    seg.safety_score,
                    seg.confidence,
                    seg.external_id,
                    seg.source,
                    seg.is_anchor,
                )

    logger.info("Trip saved: %s with %d segments", trip_id, len(body.segments))
    return SaveTripResponse(trip_id=trip_id)


# ─── GET /trips/{trip_id} ──────────────────────────────────────

@router.get("/trips/{trip_id}")
async def get_trip(trip_id: str) -> dict:
    """Fetch a saved trip with all segments."""
    pool = await get_pool()

    trip_row = await pool.fetchrow("SELECT * FROM trips WHERE id = $1", uuid.UUID(trip_id))
    if trip_row is None:
        raise HTTPException(status_code=404, detail="Trip not found")

    seg_rows = await pool.fetch(
        "SELECT * FROM trip_segments WHERE trip_id = $1 ORDER BY segment_order",
        uuid.UUID(trip_id),
    )

    return {
        "trip_id": str(trip_row["id"]),
        "user_id": str(trip_row["user_id"]),
        "origin_node_id": trip_row["origin_node_id"],
        "destination_node_id": trip_row["destination_node_id"],
        "departure_date": trip_row["departure_date"].isoformat(),
        "priority": trip_row["priority"],
        "status": trip_row["status"],
        "total_estimated_cost": str(trip_row["total_estimated_cost"]) if trip_row["total_estimated_cost"] else None,
        "total_duration_minutes": trip_row["total_duration_minutes"],
        "overall_confidence": trip_row["overall_confidence"],
        "route_status": trip_row["route_status"],
        "has_unconfirmed_legs": trip_row["has_unconfirmed_legs"],
        "segments": [
            {
                "segment_order": s["segment_order"],
                "leg_type": s["leg_type"],
                "transport_mode": s["transport_mode"],
                "from_node_id": s["from_node_id"],
                "to_node_id": s["to_node_id"],
                "departure_time": s["departure_time"].isoformat() if s["departure_time"] else None,
                "arrival_time": s["arrival_time"].isoformat() if s["arrival_time"] else None,
                "duration_minutes": s["duration_minutes"],
                "cost_inr": str(s["cost_inr"]) if s["cost_inr"] else None,
                "safety_score": s["safety_score"],
                "confidence": s["confidence"],
                "external_id": s["external_id"],
                "source": s["source"],
                "is_anchor": s["is_anchor"],
            }
            for s in seg_rows
        ],
    }


# ─── GET /trips/{trip_id}/reroute ──────────────────────────────

@router.get("/trips/{trip_id}/reroute")
async def reroute_trip(
    trip_id: str,
    from_segment_order: int,
    effective_time: str,
    request: Request,
) -> SearchRoutesResponse:
    """
    Partial re-routing from a specific segment onwards.
    Used by the Delay Domino engine's alternative finder.
    """
    pool = await get_pool()
    orchestrator = request.app.state.orchestrator

    # Get the segment to reroute from
    segment = await pool.fetchrow(
        """
        SELECT ts.from_node_id, t.destination_node_id, t.priority
        FROM trip_segments ts
        JOIN trips t ON t.id = ts.trip_id
        WHERE ts.trip_id = $1 AND ts.segment_order = $2
        """,
        uuid.UUID(trip_id),
        from_segment_order,
    )

    if segment is None:
        raise HTTPException(status_code=404, detail="Segment not found")

    # Resolve the origin node's coordinates
    graph_store = request.app.state.graph_store
    origin_node = graph_store.get_node(segment["from_node_id"])
    dest_node = graph_store.get_node(segment["destination_node_id"])

    if origin_node is None or dest_node is None:
        raise HTTPException(status_code=404, detail="Transit nodes not found")

    effective_dt = datetime.fromisoformat(effective_time)

    search_input = SearchInput(
        origin_lat=origin_node.lat,
        origin_lng=origin_node.lng,
        destination_lat=dest_node.lat,
        destination_lng=dest_node.lng,
        departure_date=effective_dt.date(),
        priority=RoutePriority(segment["priority"]),
    )

    result = await orchestrator.search(search_input)

    # Return as SearchRoutesResponse
    return SearchRoutesResponse(
        options=[
            TripOptionResponse(
                trip_id=t.trip_id,
                segments=[
                    SegmentResponse(
                        from_node_id=s.from_node_id,
                        to_node_id=s.to_node_id,
                        mode=s.mode.value,
                        leg_type=s.leg_type.value,
                        duration_minutes=s.duration_minutes,
                        cost_inr=str(s.cost_inr),
                        safety_score=s.safety_score,
                        confidence=s.confidence,
                        source=s.source,
                        departure_time=s.departure_time.isoformat() if s.departure_time else None,
                        arrival_time=s.arrival_time.isoformat() if s.arrival_time else None,
                        external_id=s.external_id,
                        distance_km=s.distance_km,
                        note=s.note,
                    )
                    for s in t.segments
                ],
                total_duration_minutes=t.total_duration_minutes,
                total_cost_inr=str(t.total_cost_inr),
                anchor_segment_index=t.anchor_segment_index,
                overall_confidence=t.overall_confidence,
                overall_safety_score=t.overall_safety_score,
                composite_score=t.composite_score,
                has_unconfirmed_legs=t.has_unconfirmed_legs,
                route_status=t.route_status.value,
            )
            for t in result.options
        ],
        origin_resolved=result.origin_resolved,
        destination_resolved=result.destination_resolved,
        routing_warnings=result.routing_warnings,
        query_duration_ms=result.query_duration_ms,
    )


# ─── Health Endpoints ───────────────────────────────────────────

health_router = APIRouter()


@health_router.get("/health/live", response_model=HealthResponse)
async def health_live() -> HealthResponse:
    """Liveness probe — always returns 200."""
    return HealthResponse(status="ok")


@health_router.get("/health/ready", response_model=HealthResponse)
async def health_ready(request: Request) -> HealthResponse:
    """Readiness probe — 200 only when GraphStore is ready."""
    graph_store = request.app.state.graph_store
    if not graph_store.is_ready:
        raise HTTPException(status_code=503, detail="GraphStore not ready")
    return HealthResponse(
        status="ready",
        graph_nodes=graph_store.node_count,
    )
