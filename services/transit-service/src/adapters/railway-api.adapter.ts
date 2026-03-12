/**
 * @module @breeze/transit-service/adapters/railway-api
 * Adapter for RailwayAPI / IRCTC train data.
 * Methods: getTrains(), getLiveStatus().
 * Cache: raw:trains 15min, raw:live 2min.
 * All calls through CircuitBreaker. AbortController 8s timeout.
 */

import type Redis from 'ioredis';
import { CircuitBreaker } from './circuit-breaker.js';
import type { AdapterCallResult } from '../models/types.js';

export class RailwayApiAdapter {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
    private readonly circuitBreaker: CircuitBreaker,
    private readonly redis: Redis,
  ) {}

  /**
   * Fetch trains between two stations for a given date.
   * Cache: raw:trains:{fromCode}:{toCode}:{date} — 15 minutes TTL.
   */
  async getTrains(
    fromIrctcCode: string,
    toIrctcCode: string,
    date: string,
  ): Promise<AdapterCallResult<unknown[]>> {
    const cacheKey = `raw:trains:${fromIrctcCode}:${toIrctcCode}:${date}`;
    const fetchedAt = new Date();

    // Check cache
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached) as unknown[];
      const ttl = await this.redis.ttl(cacheKey);
      return {
        data: parsed,
        fromCache: true,
        cacheAgeSeconds: Math.max(0, 900 - ttl), // 15min = 900s
        fetchedAt,
      };
    }

    // Live fetch through circuit breaker
    const data = await this.circuitBreaker.execute(async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8_000);

      try {
        const url = `${this.baseUrl}/between` +
          `?from=${encodeURIComponent(fromIrctcCode)}` +
          `&to=${encodeURIComponent(toIrctcCode)}` +
          `&date=${encodeURIComponent(date)}` +
          `&apikey=${this.apiKey}`;

        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) {
          throw new Error(`RailwayAPI returned ${response.status}`);
        }
        return (await response.json()) as unknown;
      } finally {
        clearTimeout(timeout);
      }
    });

    // Cache raw response
    const trains = Array.isArray(data) ? data : [];
    await this.redis.setex(cacheKey, 900, JSON.stringify(trains));

    return { data: trains, fromCache: false, cacheAgeSeconds: 0, fetchedAt };
  }

  /**
   * Fetch live running status for a train.
   * Cache: raw:live:{trainNumber}:{date} — 2 minutes TTL.
   */
  async getLiveStatus(
    trainNumber: string,
    date: string,
  ): Promise<AdapterCallResult<unknown>> {
    const cacheKey = `raw:live:${trainNumber}:${date}`;
    const fetchedAt = new Date();

    const cached = await this.redis.get(cacheKey);
    if (cached) {
      const ttl = await this.redis.ttl(cacheKey);
      return {
        data: JSON.parse(cached),
        fromCache: true,
        cacheAgeSeconds: Math.max(0, 120 - ttl),
        fetchedAt,
      };
    }

    const data = await this.circuitBreaker.execute(async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8_000);

      try {
        const url = `${this.baseUrl}/live/train/${trainNumber}/date/${date}` +
          `?apikey=${this.apiKey}`;

        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) {
          throw new Error(`RailwayAPI live status returned ${response.status}`);
        }
        return response.json();
      } finally {
        clearTimeout(timeout);
      }
    });

    await this.redis.setex(cacheKey, 120, JSON.stringify(data));

    return { data, fromCache: false, cacheAgeSeconds: 0, fetchedAt };
  }
}
