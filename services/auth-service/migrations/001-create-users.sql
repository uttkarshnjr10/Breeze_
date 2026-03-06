-- ═══════════════════════════════════════════════════════════════
-- Breeze Auth Service — Initial Schema
-- Run via: node-pg-migrate up
-- ═══════════════════════════════════════════════════════════════

-- ─── Users ─────────────────────────────────────────────────────

CREATE TABLE users (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firebase_uid                TEXT UNIQUE NOT NULL,
  email                       TEXT UNIQUE NOT NULL,
  display_name                TEXT NOT NULL,
  avatar_url                  TEXT,
  roles                       TEXT[] DEFAULT '{traveler}',
  is_verified_traveler        BOOLEAN DEFAULT FALSE,
  verified_traveler_ticket_url TEXT,
  last_login_at               TIMESTAMPTZ DEFAULT NOW(),
  created_at                  TIMESTAMPTZ DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_users_email ON users (email);
CREATE INDEX idx_users_firebase_uid ON users (firebase_uid);

-- ─── Emergency Contacts ────────────────────────────────────────

CREATE TABLE emergency_contacts (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  phone      TEXT NOT NULL,
  relation   TEXT NOT NULL CHECK (relation IN ('parent', 'spouse', 'sibling', 'friend', 'other')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_emergency_contacts_user_id ON emergency_contacts (user_id);
