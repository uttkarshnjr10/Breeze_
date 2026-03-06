/**
 * @module @breeze/api-gateway/resolvers/expense
 * Resolvers for expense operations: updateActualCost, getTripSummary.
 * Uses HTTP calls to Expense Service with 10-second timeout.
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
 * Creates expense resolvers.
 *
 * @param expenseServiceUrl - Base URL of the Expense Service.
 * @returns GraphQL resolver map.
 */
export function createExpenseResolvers(
    expenseServiceUrl: string,
): Record<string, Record<string, unknown>> {
    return {
        Mutation: {
            async updateActualCost(
                _parent: unknown,
                args: { input: { tripId: string; legId: string; actualCostInr: number } },
                context: AuthContext,
            ): Promise<unknown> {
                const headers: Record<string, string> = {
                    'Content-Type': 'application/json',
                };

                // Propagate Idempotency-Key
                const idempotencyKey = context.req.headers['idempotency-key'];
                if (typeof idempotencyKey === 'string') {
                    headers['Idempotency-Key'] = idempotencyKey;
                }

                const response = await httpFetch(`${expenseServiceUrl}/expenses/actual-cost`, {
                    method: 'PATCH',
                    headers,
                    body: JSON.stringify({
                        userId: context.userId,
                        ...args.input,
                    }),
                });

                if (!response.ok) {
                    throw new Error(`Expense service responded with status ${response.status}`);
                }

                return response.json();
            },
        },
    };
}
