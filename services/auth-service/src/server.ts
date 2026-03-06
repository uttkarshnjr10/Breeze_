/**
 * @module @breeze/auth-service/server
 * Main entry point for the auth service.
 * Bootstraps: PostgreSQL pool → Redis → Firebase → gRPC → HTTP.
 * Graceful shutdown on SIGTERM: HTTP → gRPC → Redis → DB → exit.
 */

import { Pool } from 'pg';
import Redis from 'ioredis';
import * as firebaseAdmin from 'firebase-admin';
import { loadConfig } from './config/config.js';
import { UserRepository } from './repositories/user.repository.js';
import { JWTService } from './services/jwt.service.js';
import { AuthService } from './services/auth.service.js';
import { createApp } from './app.js';
import { startGrpcServer } from './grpc/auth.grpc-server.js';

/**
 * Bootstraps the auth service.
 * Connection order: PostgreSQL → Redis → Firebase → gRPC → HTTP.
 */
async function bootstrap(): Promise<void> {
    // ─── 1. Load & validate config ──────────────────────────────
    const config = loadConfig();
    console.log('[auth-service] Configuration loaded successfully');

    // ─── 2. Connect to PostgreSQL via PgBouncer ─────────────────
    const pool = new Pool({
        connectionString: config.PGBOUNCER_URL,
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
    });

    // Verify database connectivity
    try {
        const client = await pool.connect();
        await client.query('SELECT 1');
        client.release();
        console.log('[auth-service] PostgreSQL connected (via PgBouncer)');
    } catch (error: unknown) {
        console.error('[auth-service] Failed to connect to PostgreSQL:', error);
        process.exit(1);
    }

    // ─── 3. Connect to Redis ────────────────────────────────────
    const redis = new Redis(config.REDIS_URL, {
        maxRetriesPerRequest: 3,
        lazyConnect: false,
    });

    redis.on('error', (error: Error) => {
        console.error('[auth-service] Redis error:', error.message);
    });

    console.log('[auth-service] Redis connected');

    // ─── 4. Initialize Firebase Admin ───────────────────────────
    if (!firebaseAdmin.apps.length) {
        firebaseAdmin.initializeApp({
            projectId: config.FIREBASE_PROJECT_ID,
        });
    }
    console.log('[auth-service] Firebase Admin initialized');

    // ─── 5. Create service instances ────────────────────────────
    const userRepository = new UserRepository(pool);
    const jwtService = new JWTService(config.JWT_ACCESS_SECRET, config.JWT_REFRESH_SECRET, redis);
    const authService = new AuthService(jwtService, userRepository);

    // ─── 6. Start gRPC server ──────────────────────────────────
    const grpcServer = await startGrpcServer(config.GRPC_PORT, jwtService, userRepository);

    // ─── 7. Start HTTP server ──────────────────────────────────
    const app = await createApp(authService, jwtService, config);

    await app.listen({ port: config.HTTP_PORT, host: '0.0.0.0' });
    console.log(`[auth-service] HTTP server listening on port ${config.HTTP_PORT}`);

    // ─── 8. Graceful Shutdown ──────────────────────────────────
    const shutdown = async (signal: string): Promise<void> => {
        console.log(`[auth-service] Received ${signal}. Starting graceful shutdown...`);

        try {
            // 1. Stop accepting new HTTP requests
            await app.close();
            console.log('[auth-service] HTTP server closed');

            // 2. Stop gRPC server
            grpcServer.forceShutdown();
            console.log('[auth-service] gRPC server closed');

            // 3. Close Redis
            redis.disconnect();
            console.log('[auth-service] Redis disconnected');

            // 4. Close database pool
            await pool.end();
            console.log('[auth-service] PostgreSQL pool closed');

            console.log('[auth-service] Graceful shutdown complete');
            process.exit(0);
        } catch (error: unknown) {
            console.error('[auth-service] Error during shutdown:', error);
            process.exit(1);
        }
    };

    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));
}

// ─── Start ─────────────────────────────────────────────────────

void bootstrap();
