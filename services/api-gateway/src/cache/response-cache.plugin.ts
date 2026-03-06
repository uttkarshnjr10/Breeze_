/**
 * @module @breeze/api-gateway/cache/response-cache
 * Apollo Server plugin implementing Redis-backed response caching.
 * Respects @cacheControl(maxAge) directives. Mutations are never cached.
 * Cache key: sha256(operationName + variables + userId for private ops).
 */

import crypto from 'node:crypto';
import type {
    ApolloServerPlugin,
    GraphQLRequestListener,
    BaseContext,
} from '@apollo/server';
import type Redis from 'ioredis';
import type { AuthContext } from '../directives/auth.directive.js';

/** Redis key prefix for response cache entries. */
const CACHE_PREFIX = 'gql:cache:';

// ─── Cache Key Generation ──────────────────────────────────────

/**
 * Generates a SHA-256 cache key from the operation name, variables, and userId.
 * Private queries (those with @auth) include userId to prevent cross-user leaks.
 *
 * @param operationName - GraphQL operation name.
 * @param variables - Stringified variables object.
 * @param userId - Authenticated user ID (empty string for public ops).
 * @returns Hex-encoded SHA-256 hash.
 */
export function generateCacheKey(
    operationName: string,
    variables: string,
    userId: string,
): string {
    const input = `${operationName}:${variables}:${userId}`;
    return crypto.createHash('sha256').update(input).digest('hex');
}

// ─── Plugin ────────────────────────────────────────────────────

/** Cache control hint extracted from schema directives. */
interface CacheHint {
    maxAge: number;
}

/**
 * Creates an Apollo Server plugin that caches responses in Redis.
 * Only caches queries annotated with @cacheControl(maxAge).
 * Mutations and queries without @cacheControl are never cached.
 *
 * @param redis - ioredis client for cache storage.
 * @returns Apollo Server plugin.
 */
export function responseCachePlugin(redis: Redis): ApolloServerPlugin<BaseContext> {
    return {
        async requestDidStart(): Promise<GraphQLRequestListener<BaseContext>> {
            let cacheKey: string | undefined;
            let cacheMaxAge: number | undefined;

            return {
                async responseForOperation(requestContext): Promise<null> {
                    const { request, contextValue } = requestContext;
                    const ctx = contextValue as AuthContext;

                    // Never cache mutations
                    if (request.query && /^\s*mutation/i.test(request.query)) {
                        return null;
                    }

                    // Check if the operation has @cacheControl hints in schema
                    // We look for the cacheControl hint via the info field extensions
                    const operationName = request.operationName ?? 'anonymous';
                    const variables = JSON.stringify(request.variables ?? {});
                    const userId = ctx.userId ?? '';

                    cacheKey = generateCacheKey(operationName, variables, userId);

                    // Try to read from cache
                    try {
                        const cached = await redis.get(`${CACHE_PREFIX}${cacheKey}`);
                        if (cached) {
                            const parsed = JSON.parse(cached) as { body: unknown };
                            // Return cached response
                            return {
                                http: { status: 200, headers: new Map([['x-cache', 'HIT']]) },
                                body: { kind: 'single', singleResult: parsed.body },
                            } as never;
                        }
                    } catch {
                        // Cache read failure — proceed without cache
                    }

                    return null;
                },

                async willSendResponse(requestContext): Promise<void> {
                    const { request, response } = requestContext;

                    // Never cache mutations
                    if (request.query && /^\s*mutation/i.test(request.query)) {
                        return;
                    }

                    // Extract @cacheControl maxAge from the response extensions
                    const extensions = (response.body as Record<string, unknown>)?.['extensions'] as
                        | Record<string, unknown>
                        | undefined;
                    const cacheControl = extensions?.['cacheControl'] as
                        | { hints?: CacheHint[] }
                        | undefined;

                    // Determine max age from hints
                    if (cacheControl?.hints && cacheControl.hints.length > 0) {
                        const minHint = cacheControl.hints.reduce(
                            (min, hint) => (hint.maxAge < min.maxAge ? hint : min),
                            cacheControl.hints[0] as CacheHint,
                        );
                        cacheMaxAge = minHint.maxAge;
                    }

                    // Only cache if we have a key and maxAge
                    if (!cacheKey || !cacheMaxAge || cacheMaxAge <= 0) {
                        return;
                    }

                    // Don't cache error responses
                    const body = response.body as Record<string, unknown>;
                    const singleResult = (body?.['kind'] === 'single'
                        ? body['singleResult']
                        : null) as Record<string, unknown> | null;

                    if (singleResult?.['errors']) {
                        return;
                    }

                    // Write to Redis with TTL
                    try {
                        await redis.setex(
                            `${CACHE_PREFIX}${cacheKey}`,
                            cacheMaxAge,
                            JSON.stringify({ body: singleResult }),
                        );
                    } catch {
                        // Cache write failure — non-fatal
                    }
                },
            };
        },
    };
}
