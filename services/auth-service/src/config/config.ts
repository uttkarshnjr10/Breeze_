/**
 * @module @breeze/auth-service/config
 * Zod-validated configuration loaded from environment variables.
 * The application crashes with a clear message if any required variable is missing.
 */

import { z } from 'zod';

/** Zod schema for auth-service configuration. */
const ConfigSchema = z.object({
    /** PostgreSQL connection string (via PgBouncer on port 6432). */
    PGBOUNCER_URL: z
        .string()
        .min(1, 'PGBOUNCER_URL is required')
        .default('postgresql://breeze:breeze_dev_secret@localhost:6432/breeze_dev'),

    /** Redis connection URL. */
    REDIS_URL: z.string().min(1, 'REDIS_URL is required').default('redis://localhost:6379'),

    /** Secret used to sign and verify JWT access tokens (HS256). */
    JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),

    /** Secret used to sign and verify JWT refresh tokens (HS256). */
    JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),

    /** Firebase project ID for verifying Google OAuth ID tokens. */
    FIREBASE_PROJECT_ID: z.string().min(1, 'FIREBASE_PROJECT_ID is required'),

    /** Port for the gRPC server. */
    GRPC_PORT: z.coerce.number().int().min(1).max(65535).default(50051),

    /** Port for the HTTP (Fastify) server. */
    HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(3001),

    /** Current environment. */
    NODE_ENV: z.enum(['development', 'staging', 'production']).default('development'),
});

/** Inferred TypeScript type from the Zod schema. */
export type Config = z.infer<typeof ConfigSchema>;

/**
 * Loads and validates configuration from environment variables.
 * Throws a formatted error and exits the process if validation fails.
 *
 * @returns Validated Config object.
 */
export function loadConfig(): Config {
    const result = ConfigSchema.safeParse(process.env);

    if (!result.success) {
        const errors = result.error.issues
            .map((issue) => `  • ${issue.path.join('.')}: ${issue.message}`)
            .join('\n');

        console.error(`\n❌ Auth Service configuration error:\n${errors}\n`);
        process.exit(1);
    }

    return result.data;
}
