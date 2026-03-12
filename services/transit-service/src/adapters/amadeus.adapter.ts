/**
 * @module @breeze/transit-service/adapters/amadeus
 * Adapter for Amadeus Flight Offers Search API.
 * Methods: searchFlights().
 * Cache: 30 minutes (prices change but schedule is stable).
 */

import type Redis from 'ioredis';
import { CircuitBreaker } from './circuit-breaker.js';
import type { AdapterCallResult } from '../models/types.js';

export class AmadeusAdapter {
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;

  constructor(
    private readonly apiKey: string,
    private readonly apiSecret: string,
    private readonly circuitBreaker: CircuitBreaker,
    private readonly redis: Redis,
  ) {}

  /**
   * Search flights between two airports for a date.
   * Cache: raw:flights:{origin}:{dest}:{date} — 30 minutes.
   */
  async searchFlights(
    originIata: string,
    destIata: string,
    date: string,
  ): Promise<AdapterCallResult<unknown[]>> {
    const cacheKey = `raw:flights:${originIata}:${destIata}:${date}`;
    const fetchedAt = new Date();

    const cached = await this.redis.get(cacheKey);
    if (cached) {
      const ttl = await this.redis.ttl(cacheKey);
      return {
        data: JSON.parse(cached),
        fromCache: true,
        cacheAgeSeconds: Math.max(0, 1800 - ttl),
        fetchedAt,
      };
    }

    const data = await this.circuitBreaker.execute(async () => {
      const token = await this.getAccessToken();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8_000);

      try {
        const url = 'https://api.amadeus.com/v2/shopping/flight-offers' +
          `?originLocationCode=${originIata}` +
          `&destinationLocationCode=${destIata}` +
          `&departureDate=${date}` +
          `&adults=1` +
          `&currencyCode=INR` +
          `&max=10`;

        const response = await fetch(url, {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`Amadeus returned ${response.status}`);
        }

        const json = await response.json() as { data?: unknown[] };
        return json.data ?? [];
      } finally {
        clearTimeout(timeout);
      }
    });

    const flights = Array.isArray(data) ? data : [];
    await this.redis.setex(cacheKey, 1800, JSON.stringify(flights));

    return { data: flights, fromCache: false, cacheAgeSeconds: 0, fetchedAt };
  }

  /** Get or refresh the Amadeus OAuth2 access token. */
  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 60_000) {
      return this.accessToken;
    }

    const response = await fetch('https://api.amadeus.com/v1/security/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.apiKey,
        client_secret: this.apiSecret,
      }),
    });

    if (!response.ok) {
      throw new Error(`Amadeus token request failed: ${response.status}`);
    }

    const json = await response.json() as { access_token: string; expires_in: number };
    this.accessToken = json.access_token;
    this.tokenExpiresAt = Date.now() + json.expires_in * 1000;

    return this.accessToken;
  }
}
