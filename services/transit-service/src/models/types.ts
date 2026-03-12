/**
 * @module @breeze/transit-service/models
 * Core data types for the Transit Intelligence Service.
 * TransitConnection (schedule-based) and TransportOption (demand-based).
 * Cost stored internally as integer paise (1 INR = 100 paise).
 */

// ── Enums ─────────────────────────────────────────────────────

export enum TransportMode {
  TRAIN = 'TRAIN',
  FLIGHT = 'FLIGHT',
  BUS = 'BUS',
  AUTO = 'AUTO',
  CAB = 'CAB',
  METRO = 'METRO',
  E_RICKSHAW = 'E_RICKSHAW',
  WALK = 'WALK',
}

export enum CodeSystem {
  INTERNAL = 'INTERNAL',
  IRCTC = 'IRCTC',
  IATA = 'IATA',
  GOOGLE_PLACE_ID = 'GOOGLE_PLACE_ID',
  AMADEUS = 'AMADEUS',
}

// ── Core Data Types ───────────────────────────────────────────

/**
 * TransitConnection — schedule-based transport with departure times.
 * Used for TRAIN, FLIGHT, BUS.
 */
export interface TransitConnection {
  from_node_id: string;
  to_node_id: string;
  mode: TransportMode;
  departure_time: Date;
  arrival_time: Date;
  duration_minutes: number;
  cost_inr: number;            // 2dp float for API response
  cost_paise: number;          // integer paise for internal arithmetic
  booking_available: boolean;
  external_id: string;         // train/flight number
  provider: string;            // 'railway_api' | 'amadeus' | 'google_maps'
  source_confidence: number;   // 0.0-1.0
  fetched_at: Date;
  cache_age_seconds: number;   // 0 = live, N = from cache
}

/**
 * TransportOption — demand-based transport, no departure times.
 * Used for AUTO, CAB, METRO, E_RICKSHAW, WALK.
 */
export interface TransportOption {
  from_node_id: string;
  to_node_id: string;
  mode: TransportMode;
  duration_minutes: number;
  cost_inr: number;
  cost_paise: number;
  source_confidence: number;
  fetched_at: Date;
  cache_age_seconds: number;
  provider: string;
}

// ── Fetcher Types ─────────────────────────────────────────────

export interface FetchInput {
  originNodeId: string;
  destinationNodeId: string;
  originLat: number;
  originLng: number;
  destinationLat: number;
  destinationLng: number;
  departureDate: string;       // ISO date string YYYY-MM-DD
  requestedModes: TransportMode[];
}

export interface FetchResult {
  connections: TransitConnection[];
  options: TransportOption[];
  firstMileOptions: TransportOption[];
  lastMileOptions: TransportOption[];
  failedAdapters: string[];
  partialResult: boolean;
}

// ── Adapter Types ─────────────────────────────────────────────

export interface AdapterCallResult<T> {
  data: T;
  fromCache: boolean;
  cacheAgeSeconds: number;
  fetchedAt: Date;
}

export interface LatLng {
  lat: number;
  lng: number;
}

// ── NTES Types ────────────────────────────────────────────────

export enum RiskLevel {
  CRITICAL = 'CRITICAL',   // connection window < 90min → poll 60s
  HIGH = 'HIGH',           // delayed > 15min → poll 90s
  MEDIUM = 'MEDIUM',       // departing in <6h → poll 3min
  LOW = 'LOW',             // departing in 6-24h → poll 10min
  INACTIVE = 'INACTIVE',   // departing in >24h → poll 30min
}

export const RISK_POLL_INTERVALS: Record<RiskLevel, number> = {
  [RiskLevel.CRITICAL]: 60_000,     // 60 seconds
  [RiskLevel.HIGH]: 90_000,         // 90 seconds
  [RiskLevel.MEDIUM]: 180_000,      // 3 minutes
  [RiskLevel.LOW]: 600_000,         // 10 minutes
  [RiskLevel.INACTIVE]: 1_800_000,  // 30 minutes
};

export interface MonitoredTrain {
  trainNumber: string;
  tripIds: string[];
  riskLevel: RiskLevel;
  nextPollTime: number;     // epoch ms
  lastDelayMinutes: number;
  lastEmittedDelay: number;
}
