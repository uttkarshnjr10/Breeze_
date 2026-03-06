/**
 * @module @breeze/api-gateway/middleware/rate-limiter
 * Sliding-window rate limiter using Redis sorted sets.
 * Per-operation configurable limits with X-RateLimit-* response headers.
 */

import type Redis from 'ioredis';
import type {
    ApolloServerPlugin,
    GraphQLRequestListener,
    BaseContext,
} from '@apollo/server';
import { RateLimitedError } from '@breeze/shared';
import type { AuthContext } from '../directives/auth.directive.js';

// ─── Rate Limit Configuration ──────────────────────────────────

/** Rate limit rule: max requests within a sliding window. */
interface RateLimitRule {
    readonly maxRequests: number;
    readonly windowSeconds: number;
}

/** Per-operation rate limit configuration. */
const OPERATION_LIMITS: Record<string, RateLimitRule> = {
    searchRoutes: { maxRequests: 20, windowSeconds: 60 },
    submitReview: { maxRequests: 10, windowSeconds: 3600 },
    submitFare: { maxRequests: 20, windowSeconds: 3600 },
    triggerSOS: { maxRequests: 5, windowSeconds: 300 },
};

/** Default rate limit for operations not explicitly configured. */
const DEFAULT_LIMIT: RateLimitRule = { maxRequests: 100, windowSeconds: 60 };

/** Redis key prefix for rate limit sorted sets. */
const RL_PREFIX = 'rl:';

// ─── Rate Limit Check Result ──────────────────────────────────

/** Result of a rate limit check. */
export interface RateLimitResult {
    readonly allowed: boolean;
    readonly remaining: number;
    readonly resetAt: number;
    readonly limit: number;
}

// ─── Sliding Window Implementation ────────────────────────────

/**
 * Checks whether a user is within rate limits for a given operation.
 * Uses Redis sorted sets with timestamp scores for a true sliding window.
 *
 * @param redis - ioredis client.
 * @param userId - User identifier.
 * @param operation - GraphQL operation name.
 * @returns Rate limit check result.
 */
export async function checkRateLimit(
    redis: Redis,
    userId: string,
    operation: string,
): Promise<RateLimitResult> {
    const rule = OPERATION_LIMITS[operation] ?? DEFAULT_LIMIT;
    const key = `${RL_PREFIX}${userId}:${operation}`;
    const now = Date.now();
    const windowStart = now - rule.windowSeconds * 1000;

    // Atomic pipeline: remove expired entries → count current → add new
    const pipeline = redis.pipeline();
    pipeline.zremrangebyscore(key, 0, windowStart);
    pipeline.zcard(key);
    pipeline.zadd(key, now, `${now}:${Math.random().toString(36).slice(2, 8)}`);
    pipeline.expire(key, rule.windowSeconds);

    const results = await pipeline.exec();

    // results[1] is the ZCARD result: [error, count]
    const currentCount = (results?.[1]?.[1] as number) ?? 0;
    const remaining = Math.max(0, rule.maxRequests - currentCount - 1);
    const resetAt = Math.ceil((now + rule.windowSeconds * 1000) / 1000);

    return {
        allowed: currentCount < rule.maxRequests,
        remaining,
        resetAt,
        limit: rule.maxRequests,
    };
}

// ─── Apollo Server Plugin ─────────────────────────────────────

/**
 * Creates an Apollo Server plugin that enforces per-operation rate limits.
 * Sets X-RateLimit-* response headers. Throws RateLimitedError when exceeded.
 *
 * @param redis - ioredis client.
 * @returns Apollo Server plugin.
 */
export function rateLimiterPlugin(redis: Redis): ApolloServerPlugin<BaseContext> {
    return {
        async requestDidStart(): Promise<GraphQLRequestListener<BaseContext>> {
            return {
                async didResolveOperation(requestContext): Promise<void> {
                    const ctx = requestContext.contextValue as AuthContext;
                    const userId = ctx.userId;

                    // Skip rate limiting for unauthenticated requests (they'll fail @auth anyway)
                    if (!userId) {
                        return;
                    }

                    const operationName = requestContext.request.operationName ?? 'default';
                    const result = await checkRateLimit(redis, userId, operationName);

                    // Set rate limit headers on the response
                    ctx.res.setHeader('X-RateLimit-Limit', String(result.limit));
                    ctx.res.setHeader('X-RateLimit-Remaining', String(result.remaining));
                    ctx.res.setHeader('X-RateLimit-Reset', String(result.resetAt));

                    if (!result.allowed) {
                        throw new RateLimitedError(
                            `Rate limit exceeded for operation "${operationName}". Try again later.`,
                            {
                                operation: operationName,
                                limit: result.limit,
                                resetAt: result.resetAt,
                            },
                        );
                    }
                },
            };
        },
    };
}
