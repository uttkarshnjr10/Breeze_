/**
 * @module @breeze/api-gateway/config
 * Zod-validated configuration for the API Gateway.
 * Crashes with a clear message if any required variable is missing.
 */

import { z } from 'zod';

/** Zod schema for api-gateway configuration. */
const ConfigSchema = z.object({
    /** Redis connection URL for cache and rate limiting. */
    REDIS_URL: z.string().min(1).default('redis://localhost:6379'),

    /** Auth Service gRPC host. */
    AUTH_GRPC_HOST: z.string().min(1).default('localhost'),
    /** Auth Service gRPC port. */
    AUTH_GRPC_PORT: z.coerce.number().int().min(1).max(65535).default(50051),

    /** TripGraph Service gRPC host. */
    TRIPGRAPH_GRPC_HOST: z.string().min(1).default('localhost'),
    /** TripGraph Service gRPC port. */
    TRIPGRAPH_GRPC_PORT: z.coerce.number().int().min(1).max(65535).default(50052),

    /** HTTP port for the Express + Apollo server. */
    HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(3000),

    /** Kafka broker list (comma-separated). */
    KAFKA_BROKERS: z.string().min(1).default('localhost:9092'),

    /** Safety service base URL. */
    SAFETY_SERVICE_URL: z.string().url().default('http://localhost:3004'),
    /** Community service base URL. */
    COMMUNITY_SERVICE_URL: z.string().url().default('http://localhost:3007'),
    /** Expense service base URL. */
    EXPENSE_SERVICE_URL: z.string().url().default('http://localhost:3009'),

    /** Current environment. */
    NODE_ENV: z.enum(['development', 'staging', 'production']).default('development'),
});

/** Inferred TypeScript type from the Zod schema. */
export type Config = z.infer<typeof ConfigSchema>;

/**
 * Loads and validates configuration from environment variables.
 * @returns Validated Config object.
 */
export function loadConfig(): Config {
    const result = ConfigSchema.safeParse(process.env);

    if (!result.success) {
        const errors = result.error.issues
            .map((issue) => `  • ${issue.path.join('.')}: ${issue.message}`)
            .join('\n');

        console.error(`\n❌ API Gateway configuration error:\n${errors}\n`);
        process.exit(1);
    }

    return result.data;
}
