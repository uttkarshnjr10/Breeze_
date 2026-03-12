/**
 * @module @breeze/transit-service/normalizer
 * TransitNormalizer — converts raw API responses to canonical TransitConnection
 * and TransportOption types.
 *
 * Uses StationCodeRegistry for code resolution.
 * IST → UTC conversion via date-fns-tz.
 * Costs stored as integer paise internally.
 */

import { StationCodeRegistry } from '../registry/station-code-registry.js';
import {
  CodeSystem,
  TransportMode,
  type TransitConnection,
  type TransportOption,
} from '../models/types.js';

/** Confidence tiers based on data freshness. */
function getConfidence(fromCache: boolean, cacheAgeSeconds: number, isFormula = false): number {
  if (isFormula) return 0.30;
  if (!fromCache) return 0.95;
  if (cacheAgeSeconds < 900) return 0.85;   // < 15 min
  if (cacheAgeSeconds < 3600) return 0.70;  // < 60 min
  return 0.50;
}

/** IST offset: UTC+5:30 = 330 minutes. */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Parse an IST datetime string to a UTC Date object. */
function parseIstToUtc(istDateString: string): Date {
  const date = new Date(istDateString);
  // If the string doesn't include timezone info, treat as IST
  if (!istDateString.includes('+') && !istDateString.includes('Z')) {
    return new Date(date.getTime() - IST_OFFSET_MS);
  }
  return date;
}

export class TransitNormalizer {
  constructor(private readonly registry: StationCodeRegistry) {}

  /**
   * Normalize raw railway train data to TransitConnection[].
   * Skips connections where station codes cannot be resolved.
   */
  normalizeRailwayTrains(
    rawTrains: unknown[],
    fromIrctcCode: string,
    toIrctcCode: string,
    fetchedAt: Date,
    fromCache: boolean,
    cacheAgeSeconds: number,
  ): TransitConnection[] {
    const fromNodeId = this.registry.resolve(fromIrctcCode, CodeSystem.IRCTC);
    const toNodeId = this.registry.resolve(toIrctcCode, CodeSystem.IRCTC);

    if (!fromNodeId || !toNodeId) {
      console.warn(
        `Normalizer: cannot resolve IRCTC codes: ${fromIrctcCode} → ${fromNodeId}, ${toIrctcCode} → ${toNodeId}`,
      );
      return [];
    }

    const confidence = getConfidence(fromCache, cacheAgeSeconds);
    const connections: TransitConnection[] = [];

    for (const raw of rawTrains) {
      try {
        const train = raw as Record<string, unknown>;
        const departureTime = parseIstToUtc(String(train.departure_time ?? ''));
        const arrivalTime = parseIstToUtc(String(train.arrival_time ?? ''));

        if (isNaN(departureTime.getTime()) || isNaN(arrivalTime.getTime())) {
          continue; // Skip invalid dates
        }

        const durationMs = arrivalTime.getTime() - departureTime.getTime();
        const durationMinutes = Math.max(0, Math.round(durationMs / 60_000));
        const costInr = Number(train.fare ?? train.cost ?? 0);
        const costPaise = Math.round(costInr * 100);

        // Edge case 8: validate station matches request
        const trainFrom = String(train.from_station_code ?? train.from ?? '');
        if (trainFrom && trainFrom !== fromIrctcCode) {
          console.warn(`Normalizer: misrouted train data — expected ${fromIrctcCode}, got ${trainFrom}`);
          continue;
        }

        connections.push({
          from_node_id: fromNodeId,
          to_node_id: toNodeId,
          mode: TransportMode.TRAIN,
          departure_time: departureTime,
          arrival_time: arrivalTime,
          duration_minutes: durationMinutes,
          cost_inr: costInr,
          cost_paise: costPaise,
          booking_available: Boolean(train.booking_available ?? true),
          external_id: String(train.train_number ?? train.number ?? ''),
          provider: 'railway_api',
          source_confidence: confidence,
          fetched_at: fetchedAt,
          cache_age_seconds: cacheAgeSeconds,
        });
      } catch (err) {
        console.warn('Normalizer: skipping malformed train entry:', err);
      }
    }

    return connections;
  }

  /**
   * Normalize raw Amadeus flight data.
   */
  normalizeFlights(
    rawFlights: unknown[],
    originIata: string,
    destIata: string,
    fetchedAt: Date,
    fromCache: boolean,
    cacheAgeSeconds: number,
  ): TransitConnection[] {
    const fromNodeId = this.registry.resolve(originIata, CodeSystem.IATA);
    const toNodeId = this.registry.resolve(destIata, CodeSystem.IATA);

    if (!fromNodeId || !toNodeId) {
      console.warn(
        `Normalizer: cannot resolve IATA codes: ${originIata} → ${fromNodeId}, ${destIata} → ${toNodeId}`,
      );
      return [];
    }

    const confidence = getConfidence(fromCache, cacheAgeSeconds);
    const connections: TransitConnection[] = [];

    for (const raw of rawFlights) {
      try {
        const offer = raw as Record<string, unknown>;
        const itineraries = (offer.itineraries as Array<Record<string, unknown>>) ?? [];
        const firstItin = itineraries[0];
        if (!firstItin) continue;

        const segments = (firstItin.segments as Array<Record<string, unknown>>) ?? [];
        const firstSeg = segments[0];
        const lastSeg = segments[segments.length - 1];
        if (!firstSeg || !lastSeg) continue;

        const departure = new Date(String((firstSeg.departure as Record<string, unknown>)?.at ?? ''));
        const arrival = new Date(String((lastSeg.arrival as Record<string, unknown>)?.at ?? ''));
        if (isNaN(departure.getTime()) || isNaN(arrival.getTime())) continue;

        const durationMs = arrival.getTime() - departure.getTime();
        const durationMinutes = Math.round(durationMs / 60_000);

        const price = (offer.price as Record<string, unknown>) ?? {};
        const costInr = Number(price.total ?? 0);
        const costPaise = Math.round(costInr * 100);

        const carrier = String(firstSeg.carrierCode ?? '');
        const flightNum = String(firstSeg.number ?? '');

        connections.push({
          from_node_id: fromNodeId,
          to_node_id: toNodeId,
          mode: TransportMode.FLIGHT,
          departure_time: departure,
          arrival_time: arrival,
          duration_minutes: durationMinutes,
          cost_inr: costInr,
          cost_paise: costPaise,
          booking_available: true,
          external_id: `${carrier}${flightNum}`,
          provider: 'amadeus',
          source_confidence: confidence,
          fetched_at: fetchedAt,
          cache_age_seconds: cacheAgeSeconds,
        });
      } catch (err) {
        console.warn('Normalizer: skipping malformed flight offer:', err);
      }
    }

    return connections;
  }

  /**
   * Normalize Google Maps transit directions (bus/metro).
   */
  normalizeTransitDirections(
    rawDirections: unknown,
    fetchedAt: Date,
    fromCache: boolean,
    cacheAgeSeconds: number,
  ): TransitConnection[] {
    const confidence = getConfidence(fromCache, cacheAgeSeconds);
    const connections: TransitConnection[] = [];

    try {
      const response = rawDirections as Record<string, unknown>;
      const routes = (response.routes as Array<Record<string, unknown>>) ?? [];

      for (const route of routes) {
        const legs = (route.legs as Array<Record<string, unknown>>) ?? [];
        for (const leg of legs) {
          const steps = (leg.steps as Array<Record<string, unknown>>) ?? [];

          for (const step of steps) {
            const transitDetails = step.transit_details as Record<string, unknown> | undefined;
            if (!transitDetails) continue;

            const depStop = transitDetails.departure_stop as Record<string, unknown> | undefined;
            const arrStop = transitDetails.arrival_stop as Record<string, unknown> | undefined;
            const depTime = transitDetails.departure_time as Record<string, unknown> | undefined;
            const arrTime = transitDetails.arrival_time as Record<string, unknown> | undefined;
            const line = transitDetails.line as Record<string, unknown> | undefined;

            if (!depStop || !arrStop || !depTime || !arrTime) continue;

            const depPlaceId = String(depStop.place_id ?? '');
            const arrPlaceId = String(arrStop.place_id ?? '');
            const fromNodeId = this.registry.resolve(depPlaceId, CodeSystem.GOOGLE_PLACE_ID);
            const toNodeId = this.registry.resolve(arrPlaceId, CodeSystem.GOOGLE_PLACE_ID);

            if (!fromNodeId || !toNodeId) continue;

            const departure = new Date(Number(depTime.value ?? 0) * 1000);
            const arrival = new Date(Number(arrTime.value ?? 0) * 1000);
            const durationMinutes = Math.round((arrival.getTime() - departure.getTime()) / 60_000);
            const vehicleType = String((line?.vehicle as Record<string, unknown>)?.type ?? 'BUS');

            connections.push({
              from_node_id: fromNodeId,
              to_node_id: toNodeId,
              mode: vehicleType === 'SUBWAY' || vehicleType === 'METRO_RAIL'
                ? TransportMode.METRO : TransportMode.BUS,
              departure_time: departure,
              arrival_time: arrival,
              duration_minutes: durationMinutes,
              cost_inr: 0, // Google doesn't always return fare
              cost_paise: 0,
              booking_available: false,
              external_id: String(line?.short_name ?? line?.name ?? ''),
              provider: 'google_maps',
              source_confidence: confidence,
              fetched_at: fetchedAt,
              cache_age_seconds: cacheAgeSeconds,
            });
          }
        }
      }
    } catch (err) {
      console.warn('Normalizer: error parsing transit directions:', err);
    }

    return connections;
  }

  /**
   * Normalize cab estimates from CabAdapter.
   */
  normalizeCabEstimates(
    rawEstimates: Array<{
      provider: string;
      duration_minutes: number;
      cost_paise: number;
      cost_inr: number;
      source_confidence: number;
    }>,
    fromNodeId: string,
    toNodeId: string,
    fetchedAt: Date,
  ): TransportOption[] {
    return rawEstimates.map((est) => ({
      from_node_id: fromNodeId,
      to_node_id: toNodeId,
      mode: TransportMode.CAB,
      duration_minutes: est.duration_minutes,
      cost_inr: est.cost_inr,
      cost_paise: est.cost_paise,
      source_confidence: est.source_confidence,
      fetched_at: fetchedAt,
      cache_age_seconds: 0,
      provider: est.provider,
    }));
  }
}
