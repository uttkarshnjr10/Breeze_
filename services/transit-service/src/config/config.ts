/**
 * @module @breeze/transit-service/config
 * Zod-validated configuration from environment variables.
 */

import { z } from 'zod';

const ConfigSchema = z.object({
  // ── Server ─────────────────────────────────────────────
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3003),

  // ── Database (PostgreSQL + TimescaleDB) ────────────────
  DATABASE_URL: z.string().default('postgresql://breeze:breeze_dev_secret@localhost:5432/breeze_dev'),

  // ── Redis ──────────────────────────────────────────────
  REDIS_URL: z.string().default('redis://localhost:6379'),

  // ── Kafka ──────────────────────────────────────────────
  KAFKA_BROKERS: z.string().default('localhost:9092'),
  KAFKA_CLIENT_ID: z.string().default('transit-service'),

  // ── External API Keys ─────────────────────────────────
  RAILWAY_API_KEY: z.string().default(''),
  RAILWAY_API_BASE_URL: z.string().default('https://api.railwayapi.com/v2'),
  GOOGLE_MAPS_API_KEY: z.string().default(''),
  AMADEUS_API_KEY: z.string().default(''),
  AMADEUS_API_SECRET: z.string().default(''),
  OLA_API_KEY: z.string().default(''),
  UBER_API_KEY: z.string().default(''),

  // ── TripGraph Service ─────────────────────────────────
  TRIPGRAPH_SERVICE_URL: z.string().default('http://localhost:3002'),

  // ── NTES Config ────────────────────────────────────────
  NTES_BASE_URL: z.string().default('https://enquiry.indianrail.gov.in/ntes'),
  NTES_POLL_ENABLED: z.coerce.boolean().default(false),

  // ── Cab fare rates (per city, INR per km) ─────────────
  CAB_RATE_DEFAULT_PER_KM: z.coerce.number().default(14),
  CAB_BASE_FARE_DEFAULT: z.coerce.number().default(50),
});

export type Config = z.infer<typeof ConfigSchema>;

function loadConfig(): Config {
  const result = ConfigSchema.safeParse(process.env);
  if (!result.success) {
    console.error('❌ Invalid configuration:', result.error.format());
    process.exit(1);
  }
  return result.data;
}

export const config = loadConfig();
