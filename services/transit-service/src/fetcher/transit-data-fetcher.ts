/**
 * @module @breeze/transit-service/fetcher
 * TransitDataFetcher — orchestrates adapters, merges/deduplicates results.
 * Called by the TripGraph Engine. Single entry point for all transport data.
 *
 * Adapter selection: skip adapters with health score < 0.40.
 * Deduplication: by (external_id + departure_time), keep higher confidence.
 * Uses Promise.allSettled — one adapter failure never blocks others.
 */


import { RailwayApiAdapter } from '../adapters/railway-api.adapter.js';
import { GoogleMapsAdapter } from '../adapters/google-maps.adapter.js';
import { AmadeusAdapter } from '../adapters/amadeus.adapter.js';
import { CabAdapter } from '../adapters/cab.adapter.js';
import { CircuitBreaker } from '../adapters/circuit-breaker.js';
import { TransitNormalizer } from '../normalizer/normalizer.js';
import { StationCodeRegistry } from '../registry/station-code-registry.js';
import {
  CodeSystem,
  TransportMode,
  type FetchInput,
  type FetchResult,
  type TransitConnection,
  type TransportOption,
} from '../models/types.js';

const MIN_HEALTH_SCORE = 0.40;

/**
 * Haversine distance in km between two GPS coordinates.
 */
function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export class TransitDataFetcher {
  constructor(
    private readonly railwayAdapter: RailwayApiAdapter,
    private readonly googleAdapter: GoogleMapsAdapter,
    private readonly amadeusAdapter: AmadeusAdapter,
    private readonly cabAdapter: CabAdapter,
    private readonly normalizer: TransitNormalizer,
    private readonly registry: StationCodeRegistry,
    private readonly breakers: {
      railway: CircuitBreaker;
      google: CircuitBreaker;
      amadeus: CircuitBreaker;
    },
  ) {}

  /**
   * Fetch all connections and options for a route.
   * Calls adapters concurrently. Deduplicates. Annotates with data lineage.
   */
  async fetchConnections(input: FetchInput): Promise<FetchResult> {
    const failedAdapters: string[] = [];
    const allConnections: TransitConnection[] = [];
    const allOptions: TransportOption[] = [];

    // ── Determine which adapters to call ─────────────────
    const tasks: Array<Promise<void>> = [];

    // Railway API (TRAIN mode)
    if (input.requestedModes.includes(TransportMode.TRAIN)) {
      if (this.breakers.railway.getHealthScore() >= MIN_HEALTH_SCORE) {
        tasks.push(this.fetchTrains(input, allConnections, failedAdapters));
      } else {
        failedAdapters.push('railway_api');
        console.warn('TransitDataFetcher: skipping RailwayAPI — health score below threshold');
      }
    }

    // Google Maps (BUS, METRO modes)
    if (
      input.requestedModes.includes(TransportMode.BUS) ||
      input.requestedModes.includes(TransportMode.METRO)
    ) {
      if (this.breakers.google.getHealthScore() >= MIN_HEALTH_SCORE) {
        tasks.push(this.fetchTransitDirections(input, allConnections, failedAdapters));
      } else {
        failedAdapters.push('google_maps');
      }
    }

    // Amadeus (FLIGHT mode)
    if (input.requestedModes.includes(TransportMode.FLIGHT)) {
      if (this.breakers.amadeus.getHealthScore() >= MIN_HEALTH_SCORE) {
        tasks.push(this.fetchFlights(input, allConnections, failedAdapters));
      } else {
        failedAdapters.push('amadeus');
      }
    }

    // Wait for all — never let one failure block others
    await Promise.allSettled(tasks);

    // ── Deduplicate connections ───────────────────────────
    const deduped = this.deduplicateConnections(allConnections);

    // ── First/last mile options ──────────────────────────
    const firstMileOptions: TransportOption[] = [];
    const lastMileOptions: TransportOption[] = [];

    if (
      input.requestedModes.includes(TransportMode.CAB) ||
      input.requestedModes.includes(TransportMode.AUTO)
    ) {
      const distanceKm = haversineKm(
        input.originLat, input.originLng,
        input.destinationLat, input.destinationLng,
      );

      try {
        const cabResult = await this.cabAdapter.getEstimates(
          { lat: input.originLat, lng: input.originLng },
          { lat: input.destinationLat, lng: input.destinationLng },
          distanceKm,
        );

        const normalized = this.normalizer.normalizeCabEstimates(
          cabResult.data,
          input.originNodeId,
          input.destinationNodeId,
          cabResult.fetchedAt,
        );

        // Classify as first/last mile based on distance
        if (distanceKm < 20) {
          firstMileOptions.push(...normalized);
          lastMileOptions.push(...normalized);
        } else {
          allOptions.push(...normalized);
        }
      } catch (err) {
        failedAdapters.push('cab');
        console.warn('TransitDataFetcher: cab adapter failed:', err);
      }
    }

    return {
      connections: deduped,
      options: allOptions,
      firstMileOptions,
      lastMileOptions,
      failedAdapters,
      partialResult: failedAdapters.length > 0,
    };
  }

  // ── Private fetch methods ────────────────────────────────

  private async fetchTrains(
    input: FetchInput,
    out: TransitConnection[],
    failedAdapters: string[],
  ): Promise<void> {
    try {
      const fromCode = this.registry.getExternalCode(input.originNodeId, CodeSystem.IRCTC);
      const toCode = this.registry.getExternalCode(input.destinationNodeId, CodeSystem.IRCTC);

      if (!fromCode || !toCode) {
        console.warn('TransitDataFetcher: no IRCTC codes for nodes');
        return;
      }

      const result = await this.railwayAdapter.getTrains(fromCode, toCode, input.departureDate);
      const normalized = this.normalizer.normalizeRailwayTrains(
        result.data,
        fromCode,
        toCode,
        result.fetchedAt,
        result.fromCache,
        result.cacheAgeSeconds,
      );

      out.push(...normalized);
    } catch (err) {
      failedAdapters.push('railway_api');
      console.warn('TransitDataFetcher: railway adapter failed:', err);
    }
  }

  private async fetchTransitDirections(
    input: FetchInput,
    out: TransitConnection[],
    failedAdapters: string[],
  ): Promise<void> {
    try {
      const departureEpoch = Math.floor(new Date(input.departureDate).getTime() / 1000);
      const result = await this.googleAdapter.getTransitDirections(
        { lat: input.originLat, lng: input.originLng },
        { lat: input.destinationLat, lng: input.destinationLng },
        departureEpoch,
      );

      const normalized = this.normalizer.normalizeTransitDirections(
        result.data,
        result.fetchedAt,
        result.fromCache,
        result.cacheAgeSeconds,
      );

      out.push(...normalized);
    } catch (err) {
      failedAdapters.push('google_maps');
      console.warn('TransitDataFetcher: Google Maps adapter failed:', err);
    }
  }

  private async fetchFlights(
    input: FetchInput,
    out: TransitConnection[],
    failedAdapters: string[],
  ): Promise<void> {
    try {
      const originIata = this.registry.getExternalCode(input.originNodeId, CodeSystem.IATA);
      const destIata = this.registry.getExternalCode(input.destinationNodeId, CodeSystem.IATA);

      if (!originIata || !destIata) {
        console.warn('TransitDataFetcher: no IATA codes for nodes');
        return;
      }

      const result = await this.amadeusAdapter.searchFlights(originIata, destIata, input.departureDate);
      const normalized = this.normalizer.normalizeFlights(
        result.data,
        originIata,
        destIata,
        result.fetchedAt,
        result.fromCache,
        result.cacheAgeSeconds,
      );

      out.push(...normalized);
    } catch (err) {
      failedAdapters.push('amadeus');
      console.warn('TransitDataFetcher: Amadeus adapter failed:', err);
    }
  }

  // ── Deduplication ────────────────────────────────────────

  /**
   * Deduplicate by (external_id + departure_time).
   * Keep the connection with higher source_confidence.
   */
  private deduplicateConnections(connections: TransitConnection[]): TransitConnection[] {
    const seen = new Map<string, TransitConnection>();

    for (const conn of connections) {
      const key = `${conn.external_id}:${conn.departure_time.toISOString()}`;
      const existing = seen.get(key);

      if (!existing || conn.source_confidence > existing.source_confidence) {
        if (existing) {
          console.log(
            `TransitDataFetcher: dedup — keeping ${conn.provider} (${conn.source_confidence}) over ${existing.provider} (${existing.source_confidence}) for ${conn.external_id}`,
          );
        }
        seen.set(key, conn);
      }
    }

    return Array.from(seen.values());
  }
}
