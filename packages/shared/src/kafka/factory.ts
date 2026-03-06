/**
 * @module @breeze/shared/kafka
 * Typed Kafka factory for the Breeze platform.
 * Provides idempotent producers with typed event emission and automatic header injection.
 */

import { Kafka, Producer, Consumer, CompressionTypes, logLevel } from 'kafkajs';
import type { KafkaHeaders } from '../types/index.js';

// ─── Topic Registry ────────────────────────────────────────────

/** All Kafka topics used across Breeze services. */
export const KAFKA_TOPICS = {
    TRIP_CREATED: 'breeze.trip.created',
    TRIP_UPDATED: 'breeze.trip.updated',
    BOOKING_CONFIRMED: 'breeze.booking.confirmed',
    SAFETY_ALERT: 'breeze.safety.alert',
    NOTIFICATION_DISPATCH: 'breeze.notification.dispatch',
    EXPENSE_RECORDED: 'breeze.expense.recorded',
    USER_ACTIVITY: 'breeze.user.activity',
} as const;

/** Union type of all valid topic names. */
export type KafkaTopic = (typeof KAFKA_TOPICS)[keyof typeof KAFKA_TOPICS];

// ─── Event Payload Interfaces ──────────────────────────────────

/** Payload for trip creation events. */
export interface TripCreatedPayload {
    readonly tripId: string;
    readonly userId: string;
    readonly originName: string;
    readonly destinationName: string;
    readonly departureTime: string;
    readonly createdAt: string;
}

/** Payload for trip update events. */
export interface TripUpdatedPayload {
    readonly tripId: string;
    readonly userId: string;
    readonly changes: Record<string, unknown>;
    readonly updatedAt: string;
}

/** Payload for booking confirmation events. */
export interface BookingConfirmedPayload {
    readonly bookingId: string;
    readonly tripId: string;
    readonly userId: string;
    readonly legIndex: number;
    readonly operatorName: string;
    readonly confirmedAt: string;
}

/** Payload for safety alert events. */
export interface SafetyAlertPayload {
    readonly alertId: string;
    readonly userId: string;
    readonly alertType: 'SOS' | 'GEOFENCE_BREACH' | 'INACTIVITY' | 'ROUTE_DEVIATION';
    readonly latitude: number;
    readonly longitude: number;
    readonly triggeredAt: string;
}

/** Payload for notification dispatch events. */
export interface NotificationDispatchPayload {
    readonly notificationId: string;
    readonly userId: string;
    readonly channel: 'PUSH' | 'SMS' | 'EMAIL' | 'IN_APP';
    readonly templateId: string;
    readonly data: Record<string, unknown>;
    readonly scheduledAt: string;
}

/** Payload for expense recording events. */
export interface ExpenseRecordedPayload {
    readonly expenseId: string;
    readonly tripId: string;
    readonly userId: string;
    readonly amountInr: number;
    readonly category: string;
    readonly description: string;
    readonly recordedAt: string;
}

/** Payload for user activity events. */
export interface UserActivityPayload {
    readonly userId: string;
    readonly action: string;
    readonly resource: string;
    readonly resourceId: string;
    readonly metadata: Record<string, unknown>;
    readonly occurredAt: string;
}

/** Map of topics to their respective payload types. */
export interface TopicPayloadMap {
    [KAFKA_TOPICS.TRIP_CREATED]: TripCreatedPayload;
    [KAFKA_TOPICS.TRIP_UPDATED]: TripUpdatedPayload;
    [KAFKA_TOPICS.BOOKING_CONFIRMED]: BookingConfirmedPayload;
    [KAFKA_TOPICS.SAFETY_ALERT]: SafetyAlertPayload;
    [KAFKA_TOPICS.NOTIFICATION_DISPATCH]: NotificationDispatchPayload;
    [KAFKA_TOPICS.EXPENSE_RECORDED]: ExpenseRecordedPayload;
    [KAFKA_TOPICS.USER_ACTIVITY]: UserActivityPayload;
}

// ─── Typed Producer ────────────────────────────────────────────

/** Producer wrapper that enforces topic-to-payload type safety. */
export interface TypedProducer {
    /**
     * Emits a typed message to a Kafka topic with automatic header injection.
     * @param topic - The target Kafka topic.
     * @param key - The message key (used for partitioning).
     * @param value - The typed payload.
     * @param traceId - Optional trace ID; defaults to 'unknown'.
     * @returns Promise that resolves when the message is sent.
     */
    emit<K extends KafkaTopic>(
        topic: K,
        key: string,
        value: TopicPayloadMap[K],
        traceId?: string,
    ): Promise<void>;

    /** Disconnects the producer from the Kafka cluster. */
    disconnect(): Promise<void>;
}

// ─── Kafka Factory ─────────────────────────────────────────────

/**
 * Factory for creating Kafka clients, producers, and consumers.
 * Must be initialized once at service startup via KafkaFactory.init().
 */
export class KafkaFactory {
    private static instance: Kafka | undefined;

    /**
     * Initializes the Kafka client singleton.
     * @param brokers - Array of Kafka broker addresses (e.g., ['localhost:9092']).
     * @param clientId - Unique client identifier for this service.
     * @returns The initialized Kafka instance.
     */
    static init(brokers: string[], clientId: string): Kafka {
        if (KafkaFactory.instance) {
            return KafkaFactory.instance;
        }

        KafkaFactory.instance = new Kafka({
            clientId,
            brokers,
            logLevel: logLevel.WARN,
            retry: {
                initialRetryTime: 300,
                retries: 8,
                maxRetryTime: 30000,
                factor: 2,
            },
        });

        return KafkaFactory.instance;
    }

    /**
     * Creates a type-safe Kafka producer with idempotent delivery.
     * @returns A TypedProducer with emit() method.
     * @throws Error if KafkaFactory.init() has not been called.
     */
    static async createProducer(): Promise<TypedProducer> {
        const kafka = KafkaFactory.getInstance();

        const producer: Producer = kafka.producer({
            idempotent: true,
            maxInFlightRequests: 1,
        });

        await producer.connect();

        return {
            async emit<K extends KafkaTopic>(
                topic: K,
                key: string,
                value: TopicPayloadMap[K],
                traceId: string = 'unknown',
            ): Promise<void> {
                const headers: KafkaHeaders = {
                    'x-trace-id': traceId,
                    'x-produced-at': new Date().toISOString(),
                    'x-schema-version': '1',
                };

                await producer.send({
                    topic,
                    compression: CompressionTypes.GZIP,
                    messages: [
                        {
                            key,
                            value: JSON.stringify(value),
                            headers: headers as unknown as Record<string, string>,
                        },
                    ],
                });
            },

            async disconnect(): Promise<void> {
                await producer.disconnect();
            },
        };
    }

    /**
     * Creates a Kafka consumer for the given consumer group.
     * @param groupId - The consumer group identifier.
     * @returns A connected Kafka Consumer instance.
     * @throws Error if KafkaFactory.init() has not been called.
     */
    static async createConsumer(groupId: string): Promise<Consumer> {
        const kafka = KafkaFactory.getInstance();

        const consumer: Consumer = kafka.consumer({
            groupId,
            sessionTimeout: 30000,
            heartbeatInterval: 3000,
            maxBytesPerPartition: 1048576, // 1MB
        });

        await consumer.connect();

        return consumer;
    }

    /**
     * Returns the initialized Kafka instance.
     * @returns The Kafka singleton instance.
     * @throws Error if init() has not been called.
     */
    private static getInstance(): Kafka {
        if (!KafkaFactory.instance) {
            throw new Error(
                'KafkaFactory has not been initialized. Call KafkaFactory.init(brokers, clientId) first.',
            );
        }
        return KafkaFactory.instance;
    }
}
