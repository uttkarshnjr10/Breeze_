/**
 * @module @breeze/transit-service/adapters/cab
 * Adapter for OLA + Uber APIs with formula fallback.
 * No caching — cab prices are dynamic.
 * If both APIs fail: formula estimate (base_fare + distance_km * per_km_rate).
 * Formula estimate marked with source_confidence = 0.30.
 */

import { CircuitBreaker } from './circuit-breaker.js';
import type { AdapterCallResult, LatLng } from '../models/types.js';
import { config } from '../config/config.js';

interface CabEstimate {
  provider: string;       // 'ola' | 'uber' | 'formula'
  duration_minutes: number;
  cost_paise: number;     // integer paise for internal arithmetic
  cost_inr: number;       // human-readable
  source_confidence: number;
}

export class CabAdapter {
  constructor(
    private readonly olaApiKey: string,
    private readonly uberApiKey: string,
    private readonly olaBreaker: CircuitBreaker,
    private readonly uberBreaker: CircuitBreaker,
  ) {}

  /**
   * Get cab fare estimates from OLA and Uber.
   * Falls back to formula if both fail. Never returns empty.
   */
  async getEstimates(
    origin: LatLng,
    destination: LatLng,
    distanceKm: number,
  ): Promise<AdapterCallResult<CabEstimate[]>> {
    const fetchedAt = new Date();
    const estimates: CabEstimate[] = [];

    // ── Try OLA ──────────────────────────────────────────
    const olaResult = await this.tryOla(origin, destination);
    if (olaResult) estimates.push(olaResult);

    // ── Try Uber ─────────────────────────────────────────
    const uberResult = await this.tryUber(origin, destination);
    if (uberResult) estimates.push(uberResult);

    // ── Formula fallback if both failed ──────────────────
    if (estimates.length === 0) {
      const formulaCost = Math.round(
        (config.CAB_BASE_FARE_DEFAULT + distanceKm * config.CAB_RATE_DEFAULT_PER_KM) * 100,
      );
      const durationMinutes = Math.max(10, Math.round(distanceKm / 25 * 60)); // 25 km/h avg

      estimates.push({
        provider: 'formula',
        duration_minutes: durationMinutes,
        cost_paise: formulaCost,
        cost_inr: formulaCost / 100,
        source_confidence: 0.30,
      });

      console.warn(
        `CabAdapter: both OLA and Uber failed. Using formula estimate: ₹${(formulaCost / 100).toFixed(2)}`,
      );
    }

    return {
      data: estimates,
      fromCache: false,
      cacheAgeSeconds: 0,
      fetchedAt,
    };
  }

  private async tryOla(origin: LatLng, destination: LatLng): Promise<CabEstimate | null> {
    try {
      return await this.olaBreaker.execute(async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8_000);

        try {
          const url = `https://devapi.olacabs.com/v1/products` +
            `?pickup_lat=${origin.lat}&pickup_lng=${origin.lng}` +
            `&drop_lat=${destination.lat}&drop_lng=${destination.lng}`;

          const response = await fetch(url, {
            headers: { 'X-APP-TOKEN': this.olaApiKey },
            signal: controller.signal,
          });

          if (!response.ok) throw new Error(`OLA returned ${response.status}`);

          const json = await response.json() as {
            ride_estimate?: Array<{
              estimated_fare?: number;
              estimated_travel_time_minutes?: number;
            }>;
          };

          const estimate = json.ride_estimate?.[0];
          if (!estimate?.estimated_fare) return null;

          const costPaise = Math.round(estimate.estimated_fare * 100);
          return {
            provider: 'ola',
            duration_minutes: estimate.estimated_travel_time_minutes ?? 30,
            cost_paise: costPaise,
            cost_inr: costPaise / 100,
            source_confidence: 0.85,
          };
        } finally {
          clearTimeout(timeout);
        }
      });
    } catch {
      return null;
    }
  }

  private async tryUber(origin: LatLng, destination: LatLng): Promise<CabEstimate | null> {
    try {
      return await this.uberBreaker.execute(async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8_000);

        try {
          const url = 'https://api.uber.com/v1.2/estimates/price' +
            `?start_latitude=${origin.lat}&start_longitude=${origin.lng}` +
            `&end_latitude=${destination.lat}&end_longitude=${destination.lng}`;

          const response = await fetch(url, {
            headers: { Authorization: `Bearer ${this.uberApiKey}` },
            signal: controller.signal,
          });

          if (!response.ok) throw new Error(`Uber returned ${response.status}`);

          const json = await response.json() as {
            prices?: Array<{
              estimate?: string;
              duration?: number;
              low_estimate?: number;
            }>;
          };

          const price = json.prices?.[0];
          if (!price?.low_estimate) return null;

          const costPaise = Math.round(price.low_estimate * 100);
          return {
            provider: 'uber',
            duration_minutes: Math.round((price.duration ?? 1800) / 60),
            cost_paise: costPaise,
            cost_inr: costPaise / 100,
            source_confidence: 0.85,
          };
        } finally {
          clearTimeout(timeout);
        }
      });
    } catch {
      return null;
    }
  }
}
