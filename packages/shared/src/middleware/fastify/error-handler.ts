/**
 * @module @breeze/shared/middleware/fastify/error-handler
 * Fastify error handler plugin for the Breeze platform.
 * Same structured error logic as the Express variant, adapted to Fastify's error hook.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply, FastifyError } from 'fastify';
import { BreezeError } from '../../errors/index.js';
import { ErrorCode, type ErrorResponse } from '../../types/index.js';

/**
 * Registers the Breeze error handler on a Fastify instance.
 * Converts BreezeError subclasses into structured JSON responses.
 * Non-operational errors return 500 and log full stack traces as alerts.
 *
 * @param fastify - The Fastify instance to register the error handler on.
 *
 * @example
 * ```typescript
 * import Fastify from 'fastify';
 * import { registerFastifyErrorHandler } from '@breeze/shared/middleware/fastify';
 *
 * const app = Fastify();
 * registerFastifyErrorHandler(app);
 * ```
 */
export function registerFastifyErrorHandler(fastify: FastifyInstance): void {
    fastify.setErrorHandler(
        (error: FastifyError | BreezeError | Error, request: FastifyRequest, reply: FastifyReply) => {
            const requestId =
                (request.headers['x-request-id'] as string | undefined) ?? request.id ?? 'unknown';
            const traceId = (request.headers['x-trace-id'] as string | undefined) ?? 'unknown';

            if (error instanceof BreezeError && error.isOperational) {
                const response: ErrorResponse = {
                    success: false,
                    error: {
                        code: error.code,
                        message: error.message,
                        requestId,
                        traceId,
                        metadata: error.metadata,
                    },
                };

                void reply.status(error.statusCode).send(response);
                return;
            }

            // Non-operational error — alert-worthy
            console.error('[ALERT] Non-operational error:', {
                requestId,
                traceId,
                error: error.message,
                stack: error.stack,
                url: request.url,
                method: request.method,
            });

            const response: ErrorResponse = {
                success: false,
                error: {
                    code: ErrorCode.INTERNAL_ERROR,
                    message: 'An unexpected error occurred',
                    requestId,
                    traceId,
                },
            };

            void reply.status(500).send(response);
        },
    );
}
