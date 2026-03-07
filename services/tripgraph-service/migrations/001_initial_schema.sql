-- ═══════════════════════════════════════════════════════════════
-- Breeze TripGraph Service — Initial Schema
-- ═══════════════════════════════════════════════════════════════

-- Enable pg_trgm for fuzzy text search
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ─── Transit Nodes ─────────────────────────────────────────────

CREATE TABLE transit_nodes (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  lat          DECIMAL(10,8) NOT NULL,
  lng          DECIMAL(11,8) NOT NULL,
  node_type    TEXT NOT NULL CHECK (node_type IN (
    'RAILWAY_STATION', 'BUS_STAND', 'AIRPORT', 'METRO_STATION', 'ROAD_JUNCTION'
  )),
  station_code TEXT,
  city         TEXT,
  state        TEXT,
  is_verified  BOOLEAN DEFAULT TRUE
);

-- GiST index for spatial queries (PostgreSQL fallback; primary is in-memory cKDTree)
CREATE INDEX idx_transit_nodes_lat_lng ON transit_nodes USING gist (
  point(lng, lat)
);
CREATE INDEX idx_transit_nodes_type ON transit_nodes (node_type);
CREATE INDEX idx_transit_nodes_code ON transit_nodes (station_code) WHERE station_code IS NOT NULL;

-- ─── Census Villages ──────────────────────────────────────────

CREATE TABLE census_villages (
  id           SERIAL PRIMARY KEY,
  village_name TEXT NOT NULL,
  district     TEXT,
  state        TEXT,
  lat          DECIMAL(10,8),
  lng          DECIMAL(11,8),
  population   INT
);

-- GIN index for fuzzy search via pg_trgm
CREATE INDEX idx_census_villages_name_trgm ON census_villages
  USING gin (village_name gin_trgm_ops);
CREATE INDEX idx_census_villages_state ON census_villages (state);

-- ─── Trips ────────────────────────────────────────────────────

CREATE TABLE trips (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                UUID NOT NULL,
  origin_node_id         TEXT NOT NULL,
  destination_node_id    TEXT NOT NULL,
  destination_village_name TEXT,
  departure_date         DATE NOT NULL,
  priority               TEXT NOT NULL DEFAULT 'BALANCED',
  status                 TEXT NOT NULL DEFAULT 'PLANNED',
  total_estimated_cost   NUMERIC(10,2),
  total_duration_minutes INT,
  overall_confidence     FLOAT,
  route_status           TEXT DEFAULT 'CONFIRMED',
  has_unconfirmed_legs   BOOLEAN DEFAULT FALSE,
  idempotency_key        TEXT UNIQUE,
  created_at             TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_trips_user_id ON trips (user_id);
CREATE INDEX idx_trips_departure ON trips (departure_date);
CREATE INDEX idx_trips_idempotency ON trips (idempotency_key) WHERE idempotency_key IS NOT NULL;

-- ─── Trip Segments ────────────────────────────────────────────

CREATE TABLE trip_segments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id         UUID REFERENCES trips(id) ON DELETE CASCADE,
  segment_order   INT NOT NULL,
  leg_type        TEXT NOT NULL,
  transport_mode  TEXT NOT NULL,
  from_node_id    TEXT NOT NULL,
  to_node_id      TEXT NOT NULL,
  departure_time  TIMESTAMPTZ,
  arrival_time    TIMESTAMPTZ,
  duration_minutes INT NOT NULL,
  cost_inr        NUMERIC(8,2),
  actual_cost_inr NUMERIC(8,2),
  safety_score    FLOAT,
  confidence      FLOAT,
  external_id     TEXT,
  source          TEXT,
  is_anchor       BOOLEAN DEFAULT FALSE,
  metadata        JSONB
);

CREATE INDEX idx_trip_segments_trip_order ON trip_segments (trip_id, segment_order);
CREATE INDEX idx_trip_segments_external_id ON trip_segments (external_id);
