/**
 * @module @breeze/shared
 * Root barrel export for the Breeze shared library.
 */

// Types
export * from './types/index.js';

// Errors
export * from './errors/index.js';

// Factories
export { KafkaFactory, KAFKA_TOPICS } from './kafka/factory.js';
export type {
    TypedProducer,
    KafkaTopic,
    TopicPayloadMap,
    TripCreatedPayload,
    TripUpdatedPayload,
    BookingConfirmedPayload,
    SafetyAlertPayload,
    NotificationDispatchPayload,
    ExpenseRecordedPayload,
    UserActivityPayload,
} from './kafka/factory.js';

export { RedisFactory, createLruRedisCache } from './redis/factory.js';
export type { TypedRedisClient, LruRedisCache, LruRedisCacheOptions } from './redis/factory.js';

export { createGrpcChannel } from './grpc/channel-factory.js';

// Middleware
export { expressErrorHandler, requestIdMiddleware } from './middleware/express/index.js';
export {
    registerFastifyErrorHandler,
    registerFastifyRequestId,
} from './middleware/fastify/index.js';
export { initTelemetry, getTraceId } from './middleware/observability.js';

// Utils
export { haversineKm, haversineMeters, isWithinRadius, latLngToTileXYZ } from './utils/geo.js';
export { createServiceCache } from './utils/lru-cache.js';
export type { ServiceCache } from './utils/lru-cache.js';
