/**
 * @module @breeze/api-gateway/server
 * Apollo Server 4 + Express entry point.
 * Mounts GraphQL at /api/v1/graphql with @auth directive, response cache,
 * rate limiter, and OpenTelemetry plugins. Graceful shutdown on SIGTERM.
 */

import http from 'node:http';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@apollo/server/express4';
import { ApolloServerPluginDrainHttpServer } from '@apollo/server/plugin/drainHttpServer';
import Redis from 'ioredis';
import { Kafka, type Producer } from 'kafkajs';
import {
    requestIdMiddleware,
} from '@breeze/shared';
import { loadConfig } from './config/config.js';
import { buildSchema } from './schema/type-defs.js';
import { AuthGrpcClient } from './grpc/auth.grpc-client.js';
import { TripGraphGrpcClient } from './grpc/tripgraph.grpc-client.js';
import { responseCachePlugin } from './cache/response-cache.plugin.js';
import { rateLimiterPlugin } from './middleware/rate-limiter.js';
import { createTripResolvers } from './resolvers/trip.resolver.js';
import { createSafetyResolvers } from './resolvers/safety.resolver.js';
import { createExpenseResolvers } from './resolvers/expense.resolver.js';
import { createSOSResolvers } from './resolvers/sos.resolver.js';
import type { AuthContext } from './directives/auth.directive.js';

// ─── Kafka Producer Type ───────────────────────────────────────

/** Re-exported Kafka producer type for use in resolver factories. */
export type KafkaProducer = Producer;

// ─── Bootstrap ─────────────────────────────────────────────────

/**
 * Bootstraps the API Gateway.
 * Connection order: Redis → Kafka → gRPC clients → Apollo → Express.
 */
async function bootstrap(): Promise<void> {
    // ─── 1. Load config ─────────────────────────────────────────
    const config = loadConfig();
    console.log('[api-gateway] Configuration loaded');

    // ─── 2. Connect Redis ───────────────────────────────────────
    const redis = new Redis(config.REDIS_URL, {
        maxRetriesPerRequest: 3,
        lazyConnect: false,
    });

    redis.on('error', (err: Error) => {
        console.error('[api-gateway] Redis error:', err.message);
    });

    console.log('[api-gateway] Redis connected');

    // ─── 3. Connect Kafka ──────────────────────────────────────
    const kafka = new Kafka({
        clientId: 'api-gateway',
        brokers: config.KAFKA_BROKERS.split(','),
    });

    const kafkaProducer = kafka.producer({
        idempotent: true,
        maxInFlightRequests: 1,
    });

    await kafkaProducer.connect();
    console.log('[api-gateway] Kafka producer connected');

    // ─── 4. Create gRPC clients ────────────────────────────────
    const authGrpcClient = new AuthGrpcClient(config.AUTH_GRPC_HOST, config.AUTH_GRPC_PORT);
    console.log(`[api-gateway] Auth gRPC client → ${config.AUTH_GRPC_HOST}:${config.AUTH_GRPC_PORT}`);

    const tripGraphGrpcClient = new TripGraphGrpcClient(
        config.TRIPGRAPH_GRPC_HOST,
        config.TRIPGRAPH_GRPC_PORT,
    );
    console.log(`[api-gateway] TripGraph gRPC client → ${config.TRIPGRAPH_GRPC_HOST}:${config.TRIPGRAPH_GRPC_PORT}`);

    // ─── 5. Create resolvers ──────────────────────────────────
    const tripResolvers = createTripResolvers(tripGraphGrpcClient, kafkaProducer);
    const safetyResolvers = createSafetyResolvers(config.SAFETY_SERVICE_URL, config.COMMUNITY_SERVICE_URL);
    const expenseResolvers = createExpenseResolvers(config.EXPENSE_SERVICE_URL);
    const sosResolvers = createSOSResolvers(kafkaProducer);

    // Merge resolvers
    const resolvers = {
        Query: {
            ...tripResolvers['Query'],
            ...safetyResolvers['Query'],
        } as Record<string, unknown>,
        Mutation: {
            ...tripResolvers['Mutation'],
            ...safetyResolvers['Mutation'],
            ...expenseResolvers['Mutation'],
            ...sosResolvers['Mutation'],
        } as Record<string, unknown>,
    };

    // ─── 6. Build schema with directives ──────────────────────
    const schema = buildSchema(resolvers, authGrpcClient);

    // ─── 7. Express + HTTP server ─────────────────────────────
    const app = express();
    const httpServer = http.createServer(app);

    // ─── 8. Apollo Server ─────────────────────────────────────
    const server = new ApolloServer<AuthContext>({
        schema,
        plugins: [
            // Graceful drain on shutdown
            ApolloServerPluginDrainHttpServer({ httpServer }),
            // Redis response cache
            responseCachePlugin(redis),
            // Sliding-window rate limiter
            rateLimiterPlugin(redis),
        ],
        introspection: config.NODE_ENV !== 'production',
        includeStacktraceInErrorResponses: config.NODE_ENV !== 'production',
    });

    await server.start();
    console.log('[api-gateway] Apollo Server started');

    // ─── 9. Express middleware ────────────────────────────────
    app.use(helmet({ contentSecurityPolicy: false }));
    app.use(cors({ origin: config.NODE_ENV === 'production' ? false : true, credentials: true }));
    app.use(compression());
    app.use(requestIdMiddleware);

    // Health check
    app.get('/health', (_req, res) => {
        res.json({ status: 'healthy', service: 'api-gateway', timestamp: new Date().toISOString() });
    });

    // Mount Apollo at /api/v1/graphql
    app.use(
        '/api/v1/graphql',
        express.json(),
        expressMiddleware(server, {
            context: async ({ req, res }): Promise<AuthContext> => ({
                req: { headers: req.headers as Record<string, string | string[] | undefined> },
                res: {
                    setHeader: (name: string, value: string) => {
                        res.setHeader(name, value);
                    },
                },
            }),
        }),
    );

    // ─── 10. Start listening ──────────────────────────────────
    await new Promise<void>((resolve) => {
        httpServer.listen(config.HTTP_PORT, () => {
            resolve();
        });
    });

    console.log(`[api-gateway] HTTP server listening on port ${config.HTTP_PORT}`);
    console.log(`[api-gateway] GraphQL endpoint: http://localhost:${config.HTTP_PORT}/api/v1/graphql`);

    // ─── 11. Graceful Shutdown ────────────────────────────────
    const shutdown = async (signal: string): Promise<void> => {
        console.log(`[api-gateway] Received ${signal}. Starting graceful shutdown...`);

        try {
            // 1. Stop Apollo (drains in-flight requests via plugin)
            await server.stop();
            console.log('[api-gateway] Apollo Server stopped');

            // 2. Close HTTP server
            httpServer.close();
            console.log('[api-gateway] HTTP server closed');

            // 3. Disconnect Kafka
            await kafkaProducer.disconnect();
            console.log('[api-gateway] Kafka producer disconnected');

            // 4. Close gRPC clients
            authGrpcClient.close();
            tripGraphGrpcClient.close();
            console.log('[api-gateway] gRPC clients closed');

            // 5. Disconnect Redis
            redis.disconnect();
            console.log('[api-gateway] Redis disconnected');

            console.log('[api-gateway] Graceful shutdown complete');
            process.exit(0);
        } catch (error: unknown) {
            console.error('[api-gateway] Error during shutdown:', error);
            process.exit(1);
        }
    };

    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));
}

// ─── Start ─────────────────────────────────────────────────────

void bootstrap();
