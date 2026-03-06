/**
 * @module @breeze/auth-service/controllers/auth
 * Fastify route handlers for authentication endpoints.
 * Thin controllers — business logic lives in AuthService.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { ValidationError, UnauthorizedError } from '@breeze/shared';
import type { AuthService } from '../services/auth.service.js';
import type { JWTService, JWTPayload } from '../services/jwt.service.js';
import { createRequireAuthHook } from '../hooks/require-auth.hook.js';
import type { Config } from '../config/config.js';

// ─── Request Body Types ────────────────────────────────────────

interface GoogleCallbackBody {
    readonly idToken: string;
}

interface UpdateProfileBody {
    readonly displayName?: string | undefined;
    readonly avatarUrl?: string | undefined;
    readonly emergencyContacts?: ReadonlyArray<{
        readonly name: string;
        readonly phone: string;
        readonly relation: string;
    }> | undefined;
}

// ─── Cookie Constants ──────────────────────────────────────────

const REFRESH_COOKIE_NAME = 'breeze_refresh_token';
const REFRESH_COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // 30 days in seconds

// ─── Controller ────────────────────────────────────────────────

/**
 * Registers all authentication routes on a Fastify instance.
 *
 * @param fastify - The Fastify instance.
 * @param authService - AuthService for business logic.
 * @param jwtService - JWTService for token operations.
 * @param config - Application config.
 */
export function registerAuthRoutes(
    fastify: FastifyInstance,
    authService: AuthService,
    jwtService: JWTService,
    config: Config,
): void {
    const requireAuth = createRequireAuthHook(jwtService);
    const isProduction = config.NODE_ENV === 'production';

    // ─── POST /auth/google/callback ────────────────────────────
    // Login with Firebase ID token from Google OAuth.
    // Returns access token in body, refresh token in httpOnly cookie.
    fastify.post('/auth/google/callback', async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as GoogleCallbackBody | undefined;

        if (!body?.idToken || typeof body.idToken !== 'string') {
            throw new ValidationError('idToken is required and must be a string');
        }

        const result = await authService.loginWithFirebaseToken(body.idToken);

        // Set refresh token as httpOnly cookie
        void reply.setCookie(REFRESH_COOKIE_NAME, result.tokens.refreshToken, {
            httpOnly: true,
            secure: isProduction,
            sameSite: 'strict',
            path: '/auth/refresh',
            maxAge: REFRESH_COOKIE_MAX_AGE,
        });

        return reply.status(200).send({
            success: true,
            data: {
                user: {
                    id: result.user.id,
                    email: result.user.email,
                    displayName: result.user.displayName,
                    avatarUrl: result.user.avatarUrl,
                    roles: result.user.roles,
                    isVerifiedTraveler: result.user.isVerifiedTraveler,
                },
                accessToken: result.tokens.accessToken,
            },
        });
    });

    // ─── POST /auth/refresh ────────────────────────────────────
    // Refresh access token using httpOnly refresh cookie.
    // Rotates the refresh token cookie.
    fastify.post('/auth/refresh', async (request: FastifyRequest, reply: FastifyReply) => {
        const cookies = request.cookies as Record<string, string | undefined>;
        const refreshToken = cookies[REFRESH_COOKIE_NAME];

        if (!refreshToken) {
            throw new UnauthorizedError('Refresh token cookie not found');
        }

        const result = await authService.refreshAccessToken(refreshToken);

        // Rotate refresh token cookie
        void reply.setCookie(REFRESH_COOKIE_NAME, result.refreshToken, {
            httpOnly: true,
            secure: isProduction,
            sameSite: 'strict',
            path: '/auth/refresh',
            maxAge: REFRESH_COOKIE_MAX_AGE,
        });

        return reply.status(200).send({
            success: true,
            data: {
                accessToken: result.accessToken,
            },
        });
    });

    // ─── POST /auth/logout ─────────────────────────────────────
    // Revoke refresh token and clear cookie.
    fastify.post('/auth/logout', async (request: FastifyRequest, reply: FastifyReply) => {
        const cookies = request.cookies as Record<string, string | undefined>;
        const refreshToken = cookies[REFRESH_COOKIE_NAME];

        if (refreshToken) {
            try {
                // Decode the refresh token to get the jti (no need to fully verify)
                const payload = await jwtService.verifyRefreshToken(refreshToken);
                if (payload.jti) {
                    await authService.logout(payload.jti);
                }
            } catch {
                // Silently ignore invalid tokens during logout
            }
        }

        // Clear the cookie regardless
        void reply.clearCookie(REFRESH_COOKIE_NAME, {
            httpOnly: true,
            secure: isProduction,
            sameSite: 'strict',
            path: '/auth/refresh',
        });

        return reply.status(200).send({
            success: true,
            data: { message: 'Logged out successfully' },
        });
    });

    // ─── GET /auth/me ──────────────────────────────────────────
    // Get current authenticated user.
    fastify.get(
        '/auth/me',
        { preHandler: requireAuth },
        async (request: FastifyRequest, reply: FastifyReply) => {
            const user = request.user as JWTPayload;

            const profile = await authService.getUserProfile(user.userId);
            const emergencyContacts = await authService.getEmergencyContacts(user.userId);

            return reply.status(200).send({
                success: true,
                data: {
                    user: {
                        id: profile.id,
                        email: profile.email,
                        displayName: profile.displayName,
                        avatarUrl: profile.avatarUrl,
                        roles: profile.roles,
                        isVerifiedTraveler: profile.isVerifiedTraveler,
                        lastLoginAt: profile.lastLoginAt,
                        createdAt: profile.createdAt,
                        updatedAt: profile.updatedAt,
                    },
                    emergencyContacts,
                },
            });
        },
    );

    // ─── PATCH /auth/me ────────────────────────────────────────
    // Update authenticated user's profile and/or emergency contacts.
    fastify.patch(
        '/auth/me',
        { preHandler: requireAuth },
        async (request: FastifyRequest, reply: FastifyReply) => {
            const currentUser = request.user as JWTPayload;
            const body = request.body as UpdateProfileBody | undefined;

            if (!body) {
                throw new ValidationError('Request body is required');
            }

            // Update profile fields if provided
            if (body.displayName !== undefined || body.avatarUrl !== undefined) {
                await authService.updateProfile(currentUser.userId, {
                    displayName: body.displayName,
                    avatarUrl: body.avatarUrl,
                });
            }

            // Replace emergency contacts if provided
            if (body.emergencyContacts !== undefined) {
                await authService.replaceEmergencyContacts(
                    currentUser.userId,
                    body.emergencyContacts.map((c) => ({
                        name: c.name,
                        phone: c.phone,
                        relation: c.relation,
                    })),
                );
            }

            // Return updated profile
            const profile = await authService.getUserProfile(currentUser.userId);
            const emergencyContacts = await authService.getEmergencyContacts(currentUser.userId);

            return reply.status(200).send({
                success: true,
                data: {
                    user: {
                        id: profile.id,
                        email: profile.email,
                        displayName: profile.displayName,
                        avatarUrl: profile.avatarUrl,
                        roles: profile.roles,
                        isVerifiedTraveler: profile.isVerifiedTraveler,
                        lastLoginAt: profile.lastLoginAt,
                        createdAt: profile.createdAt,
                        updatedAt: profile.updatedAt,
                    },
                    emergencyContacts,
                },
            });
        },
    );
}
