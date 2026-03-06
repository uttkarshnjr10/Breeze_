/**
 * @module @breeze/api-gateway/resolvers/safety
 * Resolvers for safety queries: getSafetyPulse, submitReview.
 * Uses HTTP calls to Safety and Community services with 10-second timeout.
 */

import type { AuthContext } from '../directives/auth.directive.js';

/** HTTP fetch with 10-second timeout. */
async function httpFetch(url: string, options: RequestInit = {}): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    try {
        return await fetch(url, {
            ...options,
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * Creates safety and community resolvers.
 *
 * @param safetyServiceUrl - Base URL of the Safety Service.
 * @param communityServiceUrl - Base URL of the Community Service.
 * @returns GraphQL resolver map.
 */
export function createSafetyResolvers(
    safetyServiceUrl: string,
    communityServiceUrl: string,
): Record<string, Record<string, unknown>> {
    return {
        Query: {
            async getSafetyPulse(
                _parent: unknown,
                args: { nodeId: string },
                context: AuthContext,
            ): Promise<unknown> {
                const headers: Record<string, string> = {
                    'Content-Type': 'application/json',
                };

                // Propagate idempotency key if present
                const idempotencyKey = context.req.headers['idempotency-key'];
                if (typeof idempotencyKey === 'string') {
                    headers['Idempotency-Key'] = idempotencyKey;
                }

                const response = await httpFetch(
                    `${safetyServiceUrl}/safety/pulse/${encodeURIComponent(args.nodeId)}`,
                    { headers },
                );

                if (!response.ok) {
                    throw new Error(`Safety service responded with status ${response.status}`);
                }

                return response.json();
            },

            async getCommunityPosts(
                _parent: unknown,
                args: { tag?: string | undefined; limit?: number | undefined; offset?: number | undefined },
                context: AuthContext,
            ): Promise<unknown> {
                const params = new URLSearchParams();
                if (args.tag) params.set('tag', args.tag);
                if (args.limit) params.set('limit', String(args.limit));
                if (args.offset) params.set('offset', String(args.offset));

                const headers: Record<string, string> = { 'Content-Type': 'application/json' };

                const idempotencyKey = context.req.headers['idempotency-key'];
                if (typeof idempotencyKey === 'string') {
                    headers['Idempotency-Key'] = idempotencyKey;
                }

                const response = await httpFetch(
                    `${communityServiceUrl}/posts?${params.toString()}`,
                    { headers },
                );

                if (!response.ok) {
                    throw new Error(`Community service responded with status ${response.status}`);
                }

                return response.json();
            },

            async getFareEstimate(
                _parent: unknown,
                args: { legType: string; originNodeId: string; destNodeId: string },
                _context: AuthContext,
            ): Promise<unknown> {
                // TODO: Call fare estimation endpoint
                return {
                    legType: args.legType,
                    minCostInr: 0,
                    maxCostInr: 0,
                    currency: 'INR',
                    source: 'estimate',
                    updatedAt: new Date().toISOString(),
                };
            },
        },

        Mutation: {
            async submitReview(
                _parent: unknown,
                args: { input: { targetNodeId: string; rating: number; body: string } },
                context: AuthContext,
            ): Promise<unknown> {
                const headers: Record<string, string> = {
                    'Content-Type': 'application/json',
                };

                const idempotencyKey = context.req.headers['idempotency-key'];
                if (typeof idempotencyKey === 'string') {
                    headers['Idempotency-Key'] = idempotencyKey;
                }

                const response = await httpFetch(`${communityServiceUrl}/reviews`, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({
                        authorId: context.userId,
                        ...args.input,
                    }),
                });

                if (!response.ok) {
                    throw new Error(`Community service responded with status ${response.status}`);
                }

                return response.json();
            },

            async submitFare(
                _parent: unknown,
                args: { legType: string; costInr: number; routeDescription: string },
                context: AuthContext,
            ): Promise<boolean> {
                const headers: Record<string, string> = {
                    'Content-Type': 'application/json',
                };

                const idempotencyKey = context.req.headers['idempotency-key'];
                if (typeof idempotencyKey === 'string') {
                    headers['Idempotency-Key'] = idempotencyKey;
                }

                const response = await httpFetch(`${communityServiceUrl}/fares`, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({
                        authorId: context.userId,
                        legType: args.legType,
                        costInr: args.costInr,
                        routeDescription: args.routeDescription,
                    }),
                });

                return response.ok;
            },
        },
    };
}
