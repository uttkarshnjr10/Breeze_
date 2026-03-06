/**
 * @module @breeze/auth-service/services/jwt
 * JWTService — issues, verifies, and revokes JWT token pairs.
 * Access tokens: HS256, 15-minute TTL.
 * Refresh tokens: HS256, 30-day TTL, jti tracked in Redis.
 */

import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import type Redis from 'ioredis';
import { UnauthorizedError } from '@breeze/shared';

// ─── Types ─────────────────────────────────────────────────────

/** Claims embedded in a Breeze JWT. */
export interface JWTPayload {
    readonly userId: string;
    readonly email: string;
    readonly roles: string[];
    readonly jti?: string | undefined;
}

/** A pair of access + refresh tokens. */
export interface TokenPair {
    readonly accessToken: string;
    readonly refreshToken: string;
    readonly refreshJti: string;
}

/** JWT durations. */
const ACCESS_TOKEN_TTL = '15m';
const REFRESH_TOKEN_TTL = '30d';
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

/** Redis key prefix for refresh token tracking. */
const RT_PREFIX = 'rt:';

// ─── Service ───────────────────────────────────────────────────

/**
 * Handles JWT issuance, verification, and revocation.
 * Secrets are injected via constructor — never read from process.env directly.
 */
export class JWTService {
    private readonly accessSecret: string;
    private readonly refreshSecret: string;
    private readonly redis: Redis;

    /**
     * @param accessSecret - Secret for signing access tokens.
     * @param refreshSecret - Secret for signing refresh tokens.
     * @param redis - ioredis client for refresh token tracking.
     */
    constructor(accessSecret: string, refreshSecret: string, redis: Redis) {
        this.accessSecret = accessSecret;
        this.refreshSecret = refreshSecret;
        this.redis = redis;
    }

    /**
     * Issues an access + refresh token pair.
     * The refresh token's jti is stored in Redis with a 30-day TTL.
     *
     * @param userId - PostgreSQL UUID of the user.
     * @param email - User's email address.
     * @param roles - User's role array.
     * @returns Token pair with accessToken, refreshToken, and refreshJti.
     */
    async issueTokenPair(userId: string, email: string, roles: string[]): Promise<TokenPair> {
        const jti = uuidv4();

        const accessToken = jwt.sign(
            { userId, email, roles } satisfies JWTPayload,
            this.accessSecret,
            { algorithm: 'HS256', expiresIn: ACCESS_TOKEN_TTL },
        );

        const refreshToken = jwt.sign(
            { userId, email, roles, jti } satisfies JWTPayload,
            this.refreshSecret,
            { algorithm: 'HS256', expiresIn: REFRESH_TOKEN_TTL },
        );

        // Track refresh token in Redis
        await this.redis.setex(`${RT_PREFIX}${jti}`, REFRESH_TOKEN_TTL_SECONDS, userId);

        return { accessToken, refreshToken, refreshJti: jti };
    }

    /**
     * Verifies an access token and returns its payload.
     * @param token - The JWT access token string.
     * @returns Decoded JWT payload.
     * @throws UnauthorizedError if the token is invalid or expired.
     */
    verifyAccessToken(token: string): JWTPayload {
        try {
            const decoded = jwt.verify(token, this.accessSecret, {
                algorithms: ['HS256'],
            }) as jwt.JwtPayload;

            return {
                userId: decoded['userId'] as string,
                email: decoded['email'] as string,
                roles: decoded['roles'] as string[],
            };
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : 'Token verification failed';
            throw new UnauthorizedError(`Invalid access token: ${message}`);
        }
    }

    /**
     * Verifies a refresh token: checks signature + confirms jti exists in Redis.
     * @param token - The JWT refresh token string.
     * @returns Decoded JWT payload including jti.
     * @throws UnauthorizedError if the token is invalid, expired, or revoked.
     */
    async verifyRefreshToken(token: string): Promise<JWTPayload> {
        let decoded: jwt.JwtPayload;

        try {
            decoded = jwt.verify(token, this.refreshSecret, {
                algorithms: ['HS256'],
            }) as jwt.JwtPayload;
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : 'Token verification failed';
            throw new UnauthorizedError(`Invalid refresh token: ${message}`);
        }

        const jti = decoded['jti'] as string | undefined;
        if (!jti) {
            throw new UnauthorizedError('Refresh token missing jti claim');
        }

        // Check Redis for the refresh token
        const exists = await this.redis.exists(`${RT_PREFIX}${jti}`);
        if (exists === 0) {
            throw new UnauthorizedError('Refresh token has been revoked');
        }

        return {
            userId: decoded['userId'] as string,
            email: decoded['email'] as string,
            roles: decoded['roles'] as string[],
            jti,
        };
    }

    /**
     * Revokes a refresh token by deleting its jti from Redis.
     * @param jti - The jti (JWT ID) of the refresh token to revoke.
     */
    async revokeRefreshToken(jti: string): Promise<void> {
        await this.redis.del(`${RT_PREFIX}${jti}`);
    }
}
