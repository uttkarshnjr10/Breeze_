/**
 * @module @breeze/shared/types
 * Core type definitions for the Breeze platform.
 */

import { z } from 'zod';

// ─── Error Types ───────────────────────────────────────────────

/** Canonical error codes used across all Breeze services. */
export enum ErrorCode {
    VALIDATION_ERROR = 'VALIDATION_ERROR',
    NOT_FOUND = 'NOT_FOUND',
    UNAUTHORIZED = 'UNAUTHORIZED',
    FORBIDDEN = 'FORBIDDEN',
    RATE_LIMITED = 'RATE_LIMITED',
    SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE',
    CONFLICT = 'CONFLICT',
    INTERNAL_ERROR = 'INTERNAL_ERROR',
}

/** Structured error response returned to API consumers. */
export interface ErrorResponse {
    readonly success: false;
    readonly error: {
        readonly code: ErrorCode;
        readonly message: string;
        readonly requestId: string;
        readonly traceId: string;
        readonly metadata?: Record<string, unknown>;
    };
}

// ─── Kafka Types ───────────────────────────────────────────────

/** Standard headers attached to every Kafka message. */
export interface KafkaHeaders {
    readonly 'x-trace-id': string;
    readonly 'x-produced-at': string;
    readonly 'x-schema-version': string;
}

/** Generic typed Kafka message envelope. */
export interface KafkaMessage<T> {
    readonly key: string;
    readonly value: T;
    readonly headers: KafkaHeaders;
    readonly timestamp: string;
}

// ─── Cache Types ───────────────────────────────────────────────

/** Configuration options for cache instances. */
export interface CacheOptions {
    readonly maxSize: number;
    readonly ttlSeconds: number;
}

/** Configuration for two-tier L1/L2 cache. */
export interface TwoTierCacheOptions extends CacheOptions {
    readonly l1TtlSeconds: number;
    readonly l2TtlSeconds: number;
    readonly name: string;
}

// ─── Geo Types ─────────────────────────────────────────────────

/** A geographic coordinate point. */
export interface GeoPoint {
    readonly latitude: number;
    readonly longitude: number;
}

/** Slippy map tile coordinates. */
export interface TileCoords {
    readonly x: number;
    readonly y: number;
    readonly z: number;
}

// ─── Zod Schemas ───────────────────────────────────────────────

/** Zod schema for validating GeoPoint objects. */
export const GeoPointSchema = z.object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
});

/** Zod schema for validating pagination parameters. */
export const PaginationSchema = z.object({
    page: z.number().int().min(1).default(1),
    limit: z.number().int().min(1).max(100).default(20),
});

/** Zod schema for validating sort parameters. */
export const SortSchema = z.object({
    field: z.string().min(1),
    order: z.enum(['asc', 'desc']).default('asc'),
});

// ─── Service Types ─────────────────────────────────────────────

/** Base configuration for any Breeze microservice. */
export interface ServiceConfig {
    readonly serviceName: string;
    readonly port: number;
    readonly env: 'development' | 'staging' | 'production';
    readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
}

/** Health check response. */
export interface HealthCheckResponse {
    readonly status: 'healthy' | 'degraded' | 'unhealthy';
    readonly service: string;
    readonly version: string;
    readonly uptime: number;
    readonly timestamp: string;
    readonly checks: ReadonlyArray<{
        readonly name: string;
        readonly status: 'pass' | 'fail';
        readonly duration: number;
    }>;
}

// ─── Transit Types ─────────────────────────────────────────────

/** Supported transit modes in the Indian transport network. */
export enum TransitMode {
    TRAIN = 'TRAIN',
    BUS = 'BUS',
    METRO = 'METRO',
    AUTO_RICKSHAW = 'AUTO_RICKSHAW',
    TAXI = 'TAXI',
    FERRY = 'FERRY',
    WALKING = 'WALKING',
    FLIGHT = 'FLIGHT',
}

/** A single leg of a multi-modal trip. */
export interface TripLeg {
    readonly mode: TransitMode;
    readonly origin: GeoPoint;
    readonly destination: GeoPoint;
    readonly originName: string;
    readonly destinationName: string;
    readonly departureTime: string;
    readonly arrivalTime: string;
    readonly durationMinutes: number;
    readonly distanceKm: number;
    readonly estimatedCostInr: number;
    readonly operatorName?: string | undefined;
}

/** Emergency contact information. */
export interface EmergencyContact {
    readonly name: string;
    readonly phone: string;
    readonly relationship: string;
}
