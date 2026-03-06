/**
 * @module @breeze/shared/middleware/observability
 * OpenTelemetry SDK initialization and trace-id helper for the Breeze platform.
 * Configures OTLP exporters, W3C propagation, and auto-instrumentation.
 */

import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { Resource } from '@opentelemetry/resources';
import { SEMRESATTRS_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { FastifyInstrumentation } from '@opentelemetry/instrumentation-fastify';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { MongoDBInstrumentation } from '@opentelemetry/instrumentation-mongodb';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { trace, context } from '@opentelemetry/api';

/** The singleton SDK instance. */
let sdkInstance: NodeSDK | undefined;

/**
 * Initializes the OpenTelemetry SDK for a Breeze microservice.
 * Must be called **before** any other imports that might be instrumented
 * (Express, Fastify, pg, MongoDB, ioredis, http).
 *
 * @param serviceName - The name of the service (e.g., 'api-gateway', 'auth-service').
 * @param otlpEndpoint - OTLP collector endpoint. Defaults to 'http://localhost:4318'.
 * @returns The initialized NodeSDK instance.
 *
 * @example
 * ```typescript
 * // At the very top of your service entry point:
 * import { initTelemetry } from '@breeze/shared/middleware/observability';
 * const sdk = initTelemetry('api-gateway');
 * // Then import Express/Fastify and start the server
 * ```
 */
export function initTelemetry(
    serviceName: string,
    otlpEndpoint: string = 'http://localhost:4318',
): NodeSDK {
    if (sdkInstance) {
        return sdkInstance;
    }

    const traceExporter = new OTLPTraceExporter({
        url: `${otlpEndpoint}/v1/traces`,
    });

    const metricReader = new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({
            url: `${otlpEndpoint}/v1/metrics`,
        }),
        exportIntervalMillis: 30000,
    });

    const sdk = new NodeSDK({
        resource: new Resource({
            [SEMRESATTRS_SERVICE_NAME]: serviceName,
        }),
        traceExporter,
        // @ts-expect-error — PeriodicExportingMetricReader has duplicate declarations between sdk-metrics and sdk-node
        metricReader,
        textMapPropagator: new W3CTraceContextPropagator(),
        instrumentations: [
            new HttpInstrumentation(),
            new ExpressInstrumentation(),
            new FastifyInstrumentation(),
            new PgInstrumentation(),
            new MongoDBInstrumentation(),
            new IORedisInstrumentation(),
        ],
    });

    sdk.start();
    sdkInstance = sdk;

    // Graceful shutdown
    const shutdown = async (): Promise<void> => {
        try {
            await sdk.shutdown();
        } catch (err: unknown) {
            console.error('Error shutting down OpenTelemetry SDK:', err);
        }
    };

    process.on('SIGTERM', () => void shutdown());
    process.on('SIGINT', () => void shutdown());

    return sdk;
}

/**
 * Retrieves the current trace ID from the active OpenTelemetry span context.
 * Returns 'no-trace' if no active span exists.
 *
 * @returns The W3C trace ID string, or 'no-trace'.
 *
 * @example
 * ```typescript
 * import { getTraceId } from '@breeze/shared/middleware/observability';
 * console.log('Current trace:', getTraceId());
 * ```
 */
export function getTraceId(): string {
    const span = trace.getSpan(context.active());
    if (!span) {
        return 'no-trace';
    }
    return span.spanContext().traceId;
}
