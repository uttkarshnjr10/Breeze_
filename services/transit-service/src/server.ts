/**
 * @module @breeze/transit-service/server
 * Fastify application — Transit Intelligence Service.
 *
 * Startup: PostgreSQL → Redis → Kafka → StationCodeRegistry →
 *          CircuitBreakers → Adapters → Normalizer → DataFetcher →
 *          NTESMonitor → Fastify routes.
 * Shutdown: NTESMonitor → Kafka → PostgreSQL → Redis (reverse order).
 */

import Fastify from 'fastify';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { Kafka } from 'kafkajs';

import { config } from './config/config.js';
import { registerRoutes } from './api/routes.js';
import { StationCodeRegistry } from './registry/station-code-registry.js';
import { CircuitBreaker } from './adapters/circuit-breaker.js';
import { RailwayApiAdapter } from './adapters/railway-api.adapter.js';
import { GoogleMapsAdapter } from './adapters/google-maps.adapter.js';
import { AmadeusAdapter } from './adapters/amadeus.adapter.js';
import { CabAdapter } from './adapters/cab.adapter.js';
import { TransitNormalizer } from './normalizer/normalizer.js';
import { TransitDataFetcher } from './fetcher/transit-data-fetcher.js';
import { NTESMonitor } from './monitor/ntes-monitor.js';

const loggerOpts = config.NODE_ENV !== 'production'
  ? { level: 'debug' as const, transport: { target: 'pino-pretty' } }
  : { level: 'info' as const };

const app = Fastify({ logger: loggerOpts });

// ── Infrastructure clients ────────────────────────────────────

const pool = new Pool({ connectionString: config.DATABASE_URL });

const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: 3,
  lazyConnect: true,
});

const kafka = new Kafka({
  clientId: config.KAFKA_CLIENT_ID,
  brokers: config.KAFKA_BROKERS.split(','),
});
const kafkaProducer = kafka.producer();

// ── Service initialization variables ──────────────────────────

let ntesMonitor: NTESMonitor | null = null;

// ── Startup ───────────────────────────────────────────────────

app.addHook('onReady', async () => {
  app.log.info('Transit Intelligence Service starting...');

  // 1. Redis
  await redis.connect();
  app.log.info('Redis connected');

  // 2. Database
  await pool.query('SELECT 1');
  app.log.info('PostgreSQL connected');

  // 3. Kafka producer
  await kafkaProducer.connect();
  app.log.info('Kafka producer connected');

  // 4. Station Code Registry
  const registry = new StationCodeRegistry();
  await registry.initialize(pool);
  app.log.info(`StationCodeRegistry: ${registry.mappingCount} mappings loaded`);

  // 5. Circuit Breakers
  const railwayBreaker = new CircuitBreaker('railway_api');
  const googleBreaker = new CircuitBreaker('google_maps');
  const amadeusBreaker = new CircuitBreaker('amadeus');
  const olaBreaker = new CircuitBreaker('ola');
  const uberBreaker = new CircuitBreaker('uber');

  // 6. Adapters
  const railwayAdapter = new RailwayApiAdapter(
    config.RAILWAY_API_KEY, config.RAILWAY_API_BASE_URL,
    railwayBreaker, redis,
  );
  const googleAdapter = new GoogleMapsAdapter(
    config.GOOGLE_MAPS_API_KEY, googleBreaker, redis,
  );
  const amadeusAdapter = new AmadeusAdapter(
    config.AMADEUS_API_KEY, config.AMADEUS_API_SECRET,
    amadeusBreaker, redis,
  );
  const cabAdapter = new CabAdapter(
    config.OLA_API_KEY, config.UBER_API_KEY,
    olaBreaker, uberBreaker,
  );

  // 7. Normalizer
  const normalizer = new TransitNormalizer(registry);

  // 8. Data Fetcher
  const fetcher = new TransitDataFetcher(
    railwayAdapter, googleAdapter, amadeusAdapter, cabAdapter,
    normalizer, registry,
    { railway: railwayBreaker, google: googleBreaker, amadeus: amadeusBreaker },
  );

  // 9. Routes
  const breakers: Record<string, CircuitBreaker> = {
    railway_api: railwayBreaker,
    google_maps: googleBreaker,
    amadeus: amadeusBreaker,
    ola: olaBreaker,
    uber: uberBreaker,
  };
  registerRoutes(app, { fetcher, railwayAdapter, pool, redis, breakers });

  // 10. NTES Monitor (optional — disabled in dev by default)
  if (config.NTES_POLL_ENABLED) {
    ntesMonitor = new NTESMonitor(railwayAdapter, redis, pool, kafkaProducer);
    await ntesMonitor.start();
    app.log.info('NTESMonitor started');
  } else {
    app.log.info('NTESMonitor disabled (NTES_POLL_ENABLED=false)');
  }

  app.log.info('Transit Intelligence Service ready');
});

// ── Shutdown ──────────────────────────────────────────────────

async function gracefulShutdown(signal: string): Promise<void> {
  app.log.info(`${signal} received — shutting down...`);

  // 1. NTES Monitor
  if (ntesMonitor) {
    await ntesMonitor.stop();
  }

  // 2. Kafka
  await kafkaProducer.disconnect();
  app.log.info('Kafka producer disconnected');

  // 3. Database
  await pool.end();
  app.log.info('PostgreSQL pool closed');

  // 4. Redis
  redis.disconnect();
  app.log.info('Redis disconnected');

  // 5. Fastify
  await app.close();
  app.log.info('Transit Intelligence Service shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ── Start ─────────────────────────────────────────────────────

async function start(): Promise<void> {
  try {
    await app.listen({ port: config.PORT, host: '0.0.0.0' });
    app.log.info(`Transit Intelligence Service listening on port ${config.PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();
