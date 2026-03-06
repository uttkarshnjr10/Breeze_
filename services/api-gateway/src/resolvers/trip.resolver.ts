/**
 * @module @breeze/api-gateway/resolvers/trip
 * Resolvers for trip-related queries and mutations.
 * searchRoutes, saveTrip, getTrip, getMyTrips.
 */

import { z } from 'zod';
import { ValidationError } from '@breeze/shared';
import type { TripGraphGrpcClient } from '../grpc/tripgraph.grpc-client.js';
import type { Producer as KafkaProducer } from 'kafkajs';
import type { AuthContext } from '../directives/auth.directive.js';

// ─── Validation Schemas ────────────────────────────────────────

const LocationInputSchema = z.object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    address: z.string().optional(),
    landmark: z.string().optional(),
});

const SearchRoutesInputSchema = z.object({
    origin: LocationInputSchema,
    destination: LocationInputSchema,
    departureTime: z.string().min(1, 'departureTime is required'),
    priority: z.enum(['FASTEST', 'CHEAPEST', 'FEWEST_TRANSFERS', 'MOST_COMFORTABLE']).optional(),
    maxResults: z.number().int().min(1).max(20).optional(),
    maxTransfers: z.number().int().min(0).max(10).optional(),
    maxWalkingKm: z.number().min(0).optional(),
    maxBudgetInr: z.number().min(0).optional(),
    excludedModes: z.array(z.string()).optional(),
    wheelchairAccessible: z.boolean().optional(),
    womenOnlyCoach: z.boolean().optional(),
});

const PRIORITY_MAP: Record<string, number> = {
    FASTEST: 1,
    CHEAPEST: 2,
    FEWEST_TRANSFERS: 3,
    MOST_COMFORTABLE: 4,
};

// ─── Resolver Factory ──────────────────────────────────────────

/**
 * Creates trip resolvers.
 *
 * @param tripGraphClient - gRPC client for the TripGraph Service.
 * @param kafkaProducer - Kafka producer for trip events.
 * @returns GraphQL resolver map for trip operations.
 */
export function createTripResolvers(
    tripGraphClient: TripGraphGrpcClient,
    kafkaProducer: KafkaProducer,
): Record<string, Record<string, unknown>> {
    return {
        Query: {
            async searchRoutes(
                _parent: unknown,
                args: { input: z.infer<typeof SearchRoutesInputSchema> },
                _context: AuthContext,
            ): Promise<unknown> {
                const parsed = SearchRoutesInputSchema.safeParse(args.input);
                if (!parsed.success) {
                    throw new ValidationError('Invalid search input', {
                        errors: parsed.error.issues,
                    });
                }

                const { origin, destination, departureTime, priority, maxResults } = parsed.data;

                const result = await tripGraphClient.searchRoutes({
                    origin: { latitude: origin.latitude, longitude: origin.longitude, address: origin.address },
                    destination: { latitude: destination.latitude, longitude: destination.longitude, address: destination.address },
                    departureTime,
                    preferences: priority
                        ? { optimizeFor: PRIORITY_MAP[priority] }
                        : undefined,
                    maxResults: maxResults ?? 5,
                });

                return {
                    routes: result.routes,
                    computedAt: result.computedAt || new Date().toISOString(),
                };
            },

            async getTrip(
                _parent: unknown,
                args: { tripId: string },
                _context: AuthContext,
            ): Promise<unknown> {
                // TODO: Implement via TripGraph service gRPC call
                return { id: args.tripId, status: 'PLANNED', legs: [], summary: null, savedAt: new Date().toISOString() };
            },

            async getMyTrips(
                _parent: unknown,
                _args: unknown,
                context: AuthContext,
            ): Promise<unknown[]> {
                // TODO: Implement via TripGraph service gRPC call
                void context.userId;
                return [];
            },
        },

        Mutation: {
            async saveTrip(
                _parent: unknown,
                args: { input: { routeId: string; legs: Array<{ legId: string; type: string; estimatedCostInr: number }> } },
                context: AuthContext,
            ): Promise<unknown> {
                const { routeId, legs } = args.input;
                const userId = context.userId ?? '';

                // Emit trip.created Kafka event with trace headers
                const traceId = context.req.headers['x-trace-id'] ?? '';
                await kafkaProducer.send({
                    topic: 'breeze.trip.created',
                    messages: [
                        {
                            key: userId,
                            value: JSON.stringify({
                                userId,
                                routeId,
                                legs,
                                createdAt: new Date().toISOString(),
                            }),
                            headers: {
                                'x-trace-id': String(traceId),
                                'x-produced-at': new Date().toISOString(),
                            },
                        },
                    ],
                });

                return {
                    id: routeId,
                    userId,
                    routeId,
                    status: 'PLANNED',
                    legs: [],
                    summary: { totalDurationMinutes: 0, totalDistanceKm: 0, totalCostInr: 0, transferCount: 0, walkingDistanceKm: 0 },
                    savedAt: new Date().toISOString(),
                };
            },
        },
    };
}
