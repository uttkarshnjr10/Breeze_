/**
 * @module @breeze/auth-service/hooks/require-auth
 * Fastify preHandler hook that enforces Bearer token authentication.
 * Extracts the JWT from the Authorization header, verifies it,
 * and attaches the decoded payload to request.user.
 */

import type { FastifyRequest, FastifyReply, HookHandlerDoneFunction } from 'fastify';
import { UnauthorizedError } from '@breeze/shared';
import type { JWTPayload } from '../services/jwt.service.js';
import type { JWTService } from '../services/jwt.service.js';

// ─── Type Augmentation ─────────────────────────────────────────

declare module 'fastify' {
    interface FastifyRequest {
        user?: JWTPayload | undefined;
    }
}

// ─── Hook Factory ──────────────────────────────────────────────

/**
 * Creates a Fastify preHandler hook that requires a valid Bearer token.
 * The decoded JWT payload is attached to `request.user`.
 *
 * @param jwtService - The JWTService instance for token verification.
 * @returns A Fastify preHandler hook function.
 *
 * @example
 * ```typescript
 * const requireAuth = createRequireAuthHook(jwtService);
 * fastify.get('/me', { preHandler: requireAuth }, handler);
 * ```
 */
export function createRequireAuthHook(
    jwtService: JWTService,
): (request: FastifyRequest, reply: FastifyReply, done: HookHandlerDoneFunction) => void {
    return (request: FastifyRequest, _reply: FastifyReply, done: HookHandlerDoneFunction): void => {
        const authHeader = request.headers['authorization'];

        if (!authHeader || typeof authHeader !== 'string') {
            done(new UnauthorizedError('Missing Authorization header'));
            return;
        }

        const parts = authHeader.split(' ');
        if (parts.length !== 2 || parts[0] !== 'Bearer') {
            done(new UnauthorizedError('Invalid Authorization header format. Expected: Bearer <token>'));
            return;
        }

        const token = parts[1];
        if (!token) {
            done(new UnauthorizedError('Missing token in Authorization header'));
            return;
        }

        try {
            const payload = jwtService.verifyAccessToken(token);
            request.user = payload;
            done();
        } catch (error: unknown) {
            if (error instanceof Error) {
                done(error);
            } else {
                done(new UnauthorizedError('Token verification failed'));
            }
        }
    };
}
