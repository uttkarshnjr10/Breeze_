/**
 * @module @breeze/auth-service/app
 * Fastify application instance with all plugins and routes registered.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyCors from '@fastify/cors';
import fastifyHelmet from '@fastify/helmet';
import fastifyCompress from '@fastify/compress';
import {
    registerFastifyErrorHandler,
    registerFastifyRequestId,
} from '@breeze/shared';
import { registerAuthRoutes } from './controllers/auth.controller.js';
import type { AuthService } from './services/auth.service.js';
import type { JWTService } from './services/jwt.service.js';
import type { Config } from './config/config.js';

/**
 * Creates and configures the Fastify application instance.
 *
 * @param authService - AuthService for business logic.
 * @param jwtService - JWTService for token operations.
 * @param config - Application configuration.
 * @returns Configured Fastify instance (not yet listening).
 */
export async function createApp(
    authService: AuthService,
    jwtService: JWTService,
    config: Config,
): Promise<FastifyInstance> {
    const app = Fastify({
        logger: {
            level: config.NODE_ENV === 'production' ? 'info' : 'debug',
        },
        genReqId: () => '', // Let our shared requestId hook handle it
    });

    // ─── Plugins ────────────────────────────────────────────────
    await app.register(fastifyCookie);
    await app.register(fastifyCors, {
        origin: config.NODE_ENV === 'production' ? false : true,
        credentials: true,
    });
    await app.register(fastifyHelmet);
    await app.register(fastifyCompress);

    // ─── Shared Middleware ──────────────────────────────────────
    registerFastifyRequestId(app);
    registerFastifyErrorHandler(app);

    // ─── Health Check ───────────────────────────────────────────
    app.get('/health', async (_request, reply) => {
        return reply.status(200).send({
            status: 'healthy',
            service: 'auth-service',
            timestamp: new Date().toISOString(),
        });
    });

    // ─── Auth Routes ────────────────────────────────────────────
    registerAuthRoutes(app, authService, jwtService, config);

    return app;
}
