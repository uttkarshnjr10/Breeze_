-- ═══════════════════════════════════════════════════════════════
-- Breeze Transit Intelligence Service — Migrations
-- ═══════════════════════════════════════════════════════════════

-- ─── Station Code Mappings ────────────────────────────────────

CREATE TABLE IF NOT EXISTS station_code_mappings (
  internal_id   TEXT NOT NULL,
  code_system   TEXT NOT NULL CHECK (code_system IN ('IRCTC', 'IATA', 'GOOGLE_PLACE_ID', 'AMADEUS')),
  external_code TEXT NOT NULL,
  UNIQUE(code_system, external_code)
);

CREATE INDEX IF NOT EXISTS idx_scm_internal ON station_code_mappings (internal_id, code_system);
CREATE INDEX IF NOT EXISTS idx_scm_external ON station_code_mappings (external_code, code_system);

-- ─── Train Status History (TimescaleDB) ───────────────────────

CREATE TABLE IF NOT EXISTS train_status_history (
  time                TIMESTAMPTZ NOT NULL,
  train_number        TEXT NOT NULL,
  current_station     TEXT,
  delay_minutes       INT NOT NULL DEFAULT 0,
  on_time_performance FLOAT,
  raw_response        JSONB
);

-- Create hypertable (idempotent: skip if already exists)
DO $$
BEGIN
  PERFORM create_hypertable('train_status_history', 'time', if_not_exists => TRUE);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Hypertable already exists or TimescaleDB not available: %', SQLERRM;
END $$;

CREATE INDEX IF NOT EXISTS idx_tsh_train_time ON train_status_history (train_number, time DESC);

-- Retention policy: 90 days (idempotent)
DO $$
BEGIN
  PERFORM add_retention_policy('train_status_history', INTERVAL '90 days', if_not_exists => TRUE);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Retention policy skipped: %', SQLERRM;
END $$;

-- Compression policy: compress data older than 7 days (idempotent)
DO $$
BEGIN
  ALTER TABLE train_status_history SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'train_number',
    timescaledb.compress_orderby = 'time DESC'
  );
  PERFORM add_compression_policy('train_status_history', INTERVAL '7 days', if_not_exists => TRUE);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Compression policy skipped: %', SQLERRM;
END $$;
