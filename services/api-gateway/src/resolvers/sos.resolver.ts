/**
 * @module @breeze/api-gateway/resolvers/sos
 * Resolver for triggerSOS mutation.
 * Publishes to Kafka IMMEDIATELY (fire-and-forget, < 5ms).
 * Returns { acknowledged: true } — does NOT wait for SMS delivery.
 */

import { v4 as uuidv4 } from 'uuid';
import type { Producer as KafkaProducer } from 'kafkajs';
import type { AuthContext } from '../directives/auth.directive.js';

/**
 * Creates the SOS resolver.
 * CRITICAL: Kafka publish is fire-and-forget. Never await delivery confirmation
 * in the resolver response path.
 *
 * @param kafkaProducer - Kafka producer for SOS events.
 * @returns GraphQL resolver map.
 */
export function createSOSResolvers(
    kafkaProducer: KafkaProducer,
): Record<string, Record<string, unknown>> {
    return {
        Mutation: {
            triggerSOS(
                _parent: unknown,
                args: { input: { location: { latitude: number; longitude: number }; message?: string | undefined } },
                context: AuthContext,
            ): { acknowledged: boolean; timestamp: string; sosId: string } {
                const sosId = uuidv4();
                const timestamp = new Date().toISOString();
                const userId = context.userId ?? '';
                const traceId = context.req.headers['x-trace-id'] ?? '';

                // Fire-and-forget Kafka publish — do NOT await
                void kafkaProducer.send({
                    topic: 'breeze.safety.alert',
                    messages: [
                        {
                            key: userId,
                            value: JSON.stringify({
                                sosId,
                                userId,
                                location: args.input.location,
                                message: args.input.message ?? '',
                                triggeredAt: timestamp,
                            }),
                            headers: {
                                'x-trace-id': String(traceId),
                                'x-produced-at': timestamp,
                                'x-schema-version': '1',
                            },
                        },
                    ],
                });

                // Return immediately — do NOT wait for SMS delivery
                return {
                    acknowledged: true,
                    timestamp,
                    sosId,
                };
            },
        },
    };
}
