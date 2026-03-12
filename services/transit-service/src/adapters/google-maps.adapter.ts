/**
 * @module @breeze/transit-service/adapters/google-maps
 * Adapter for Google Maps Directions API (transit mode) + Places API.
 * Methods: getTransitDirections(), getNearbyTransitStops().
 * Cache: directions 15min, stops 60min.
 */

import type Redis from 'ioredis';
import { CircuitBreaker } from './circuit-breaker.js';
import type { AdapterCallResult, LatLng } from '../models/types.js';

export class GoogleMapsAdapter {
  constructor(
    private readonly apiKey: string,
    private readonly circuitBreaker: CircuitBreaker,
    private readonly redis: Redis,
  ) {}

  /**
   * Get transit directions (bus, metro) between two points.
   * Cache: 15 minutes.
   */
  async getTransitDirections(
    origin: LatLng,
    destination: LatLng,
    departureTime: number, // epoch seconds
  ): Promise<AdapterCallResult<unknown>> {
    const cacheKey = `raw:gmaps:transit:${origin.lat},${origin.lng}:${destination.lat},${destination.lng}:${departureTime}`;
    const fetchedAt = new Date();

    const cached = await this.redis.get(cacheKey);
    if (cached) {
      const ttl = await this.redis.ttl(cacheKey);
      return {
        data: JSON.parse(cached),
        fromCache: true,
        cacheAgeSeconds: Math.max(0, 900 - ttl),
        fetchedAt,
      };
    }

    const data = await this.circuitBreaker.execute(async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8_000);

      try {
        const url = 'https://maps.googleapis.com/maps/api/directions/json' +
          `?origin=${origin.lat},${origin.lng}` +
          `&destination=${destination.lat},${destination.lng}` +
          `&mode=transit` +
          `&departure_time=${departureTime}` +
          `&alternatives=true` +
          `&key=${this.apiKey}`;

        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) {
          throw new Error(`Google Maps returned ${response.status}`);
        }
        return response.json();
      } finally {
        clearTimeout(timeout);
      }
    });

    await this.redis.setex(cacheKey, 900, JSON.stringify(data));

    return { data, fromCache: false, cacheAgeSeconds: 0, fetchedAt };
  }

  /**
   * Find nearby transit stops (bus stands, metro stations).
   * Cache: 60 minutes (transit stop locations rarely change).
   */
  async getNearbyTransitStops(
    lat: number,
    lng: number,
    radiusMeters: number = 3000,
    types: string[] = ['transit_station', 'bus_station', 'subway_station'],
  ): Promise<AdapterCallResult<unknown[]>> {
    const typeKey = types.sort().join(',');
    const cacheKey = `raw:gmaps:nearby:${lat.toFixed(4)},${lng.toFixed(4)}:${radiusMeters}:${typeKey}`;
    const fetchedAt = new Date();

    const cached = await this.redis.get(cacheKey);
    if (cached) {
      const ttl = await this.redis.ttl(cacheKey);
      return {
        data: JSON.parse(cached),
        fromCache: true,
        cacheAgeSeconds: Math.max(0, 3600 - ttl),
        fetchedAt,
      };
    }

    const data = await this.circuitBreaker.execute(async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8_000);

      try {
        const url = 'https://maps.googleapis.com/maps/api/place/nearbysearch/json' +
          `?location=${lat},${lng}` +
          `&radius=${radiusMeters}` +
          `&type=${types.join('|')}` +
          `&key=${this.apiKey}`;

        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) {
          throw new Error(`Google Places returned ${response.status}`);
        }
        return response.json();
      } finally {
        clearTimeout(timeout);
      }
    });

    const results = Array.isArray(data) ? data : [];
    await this.redis.setex(cacheKey, 3600, JSON.stringify(results));

    return { data: results, fromCache: false, cacheAgeSeconds: 0, fetchedAt };
  }
}
