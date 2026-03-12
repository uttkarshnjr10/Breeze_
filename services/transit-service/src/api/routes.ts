/**
 * @module @breeze/transit-service/api/routes
 * Fastify routes — prefix /api/v1.
 * Consumed by TripGraph Engine, not frontend directly.
 *
 * GET /transit/connections — fetch schedule + demand options
 * GET /transit/train-status/:trainNumber — live NTES status
 * GET /transit/nodes/nearby — haversine query on transit_nodes
 * GET /transit/adapters/health — circuit breaker health dashboard
 * GET /health/live, GET /health/ready
 */

import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { TransitDataFetcher } from '../fetcher/transit-data-fetcher.js';
import type { RailwayApiAdapter } from '../adapters/railway-api.adapter.js';
import type { CircuitBreaker } from '../adapters/circuit-breaker.js';
import { TransportMode } from '../models/types.js';

interface RouteDeps {
  fetcher: TransitDataFetcher;
  railwayAdapter: RailwayApiAdapter;
  pool: Pool;
  redis: import('ioredis').default;
  breakers: Record<string, CircuitBreaker>;
}

export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { fetcher, railwayAdapter, pool, redis, breakers } = deps;

  // ── GET /api/v1/transit/connections ─────────────────────
  app.get('/api/v1/transit/connections', async (request, reply) => {
    const query = request.query as {
      originNodeId?: string;
      destinationNodeId?: string;
      departureDate?: string;
      modes?: string;
      originLat?: string;
      originLng?: string;
      destinationLat?: string;
      destinationLng?: string;
    };

    if (!query.originNodeId || !query.destinationNodeId || !query.departureDate) {
      return reply.status(400).send({
        error: 'Missing required params: originNodeId, destinationNodeId, departureDate',
      });
    }

    const modes = query.modes
      ? query.modes.split(',').map((m) => m.trim() as TransportMode)
      : Object.values(TransportMode);

    const result = await fetcher.fetchConnections({
      originNodeId: query.originNodeId,
      destinationNodeId: query.destinationNodeId,
      originLat: Number(query.originLat ?? 0),
      originLng: Number(query.originLng ?? 0),
      destinationLat: Number(query.destinationLat ?? 0),
      destinationLng: Number(query.destinationLng ?? 0),
      departureDate: query.departureDate,
      requestedModes: modes,
    });

    // Convert costs from paise to INR for API response
    const connections = result.connections.map((c) => ({
      ...c,
      departure_time: c.departure_time.toISOString(),
      arrival_time: c.arrival_time.toISOString(),
      fetched_at: c.fetched_at.toISOString(),
      cost_inr: c.cost_paise / 100,
    }));

    return reply.send({
      connections,
      options: result.options.map((o) => ({
        ...o,
        fetched_at: o.fetched_at.toISOString(),
        cost_inr: o.cost_paise / 100,
      })),
      firstMileOptions: result.firstMileOptions,
      lastMileOptions: result.lastMileOptions,
      failedAdapters: result.failedAdapters,
      partialResult: result.partialResult,
    });
  });

  // ── GET /api/v1/transit/train-status/:trainNumber ──────
  app.get('/api/v1/transit/train-status/:trainNumber', async (request, reply) => {
    const { trainNumber } = request.params as { trainNumber: string };

    // Check Redis cache (2-minute TTL from RailwayApiAdapter)
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const cacheKey = `raw:live:${trainNumber}:${today}`;
    const cached = await redis.get(cacheKey);

    let liveData: Record<string, unknown>;
    let dataFreshness: 'live' | 'cached';

    if (cached) {
      liveData = JSON.parse(cached) as Record<string, unknown>;
      dataFreshness = 'cached';
    } else {
      try {
        const result = await railwayAdapter.getLiveStatus(trainNumber, today);
        liveData = result.data as Record<string, unknown>;
        dataFreshness = 'live';
      } catch (err) {
        return reply.status(503).send({
          error: 'Unable to fetch live train status',
          trainNumber,
        });
      }
    }

    // Get on_time_performance from TimescaleDB
    let onTimePerformance = 0;
    try {
      const { rows } = await pool.query(
        `SELECT on_time_performance FROM train_status_history
         WHERE train_number = $1 ORDER BY time DESC LIMIT 1`,
        [trainNumber],
      );
      onTimePerformance = rows[0]?.on_time_performance ?? 0;
    } catch {
      // Non-critical — return 0
    }

    return reply.send({
      trainNumber,
      delayMinutes: Math.max(0, Number(liveData.delay_minutes ?? liveData.late_mins ?? 0)),
      currentStation: String(liveData.current_station ?? liveData.curr_stn ?? ''),
      lastUpdated: new Date().toISOString(),
      onTimePerformance,
      dataFreshness,
    });
  });

  // ── GET /api/v1/transit/nodes/nearby ───────────────────
  app.get('/api/v1/transit/nodes/nearby', async (request, reply) => {
    const query = request.query as {
      lat?: string;
      lng?: string;
      radiusKm?: string;
      nodeType?: string;
    };

    if (!query.lat || !query.lng) {
      return reply.status(400).send({ error: 'Missing required params: lat, lng' });
    }

    const lat = Number(query.lat);
    const lng = Number(query.lng);
    const radiusKm = Number(query.radiusKm ?? 5);
    const nodeType = query.nodeType ?? null;

    // Haversine query on transit_nodes table
    let sql = `
      SELECT *, (
        6371 * acos(
          LEAST(1.0, cos(radians($1)) * cos(radians(lat)) *
          cos(radians(lng) - radians($2)) +
          sin(radians($1)) * sin(radians(lat)))
        )
      ) AS distance_km
      FROM transit_nodes
      WHERE (
        6371 * acos(
          LEAST(1.0, cos(radians($1)) * cos(radians(lat)) *
          cos(radians(lng) - radians($2)) +
          sin(radians($1)) * sin(radians(lat)))
        )
      ) <= $3
    `;

    const params: unknown[] = [lat, lng, radiusKm];

    if (nodeType) {
      sql += ` AND node_type = $4`;
      params.push(nodeType);
    }

    sql += ` ORDER BY distance_km LIMIT 50`;

    const { rows } = await pool.query(sql, params);
    return reply.send({ nodes: rows });
  });

  // ── GET /api/v1/transit/adapters/health ────────────────
  app.get('/api/v1/transit/adapters/health', async (_request, reply) => {
    const health: Record<string, { state: string; healthScore: number }> = {};

    for (const [name, breaker] of Object.entries(breakers)) {
      health[name] = {
        state: breaker.getState(),
        healthScore: Number(breaker.getHealthScore().toFixed(3)),
      };
    }

    return reply.send({ adapters: health });
  });

  // ── Health endpoints ───────────────────────────────────
  app.get('/health/live', async (_request, reply) => {
    return reply.send({ status: 'ok', service: 'transit-service' });
  });

  app.get('/health/ready', async (_request, reply) => {
    // Check: PostgreSQL, Redis, Kafka
    try {
      await pool.query('SELECT 1');
      await redis.ping();
      return reply.send({ status: 'ready', service: 'transit-service' });
    } catch (err) {
      return reply.status(503).send({
        status: 'not_ready',
        error: String(err),
      });
    }
  });
}
