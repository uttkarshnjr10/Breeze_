/**
 * @module @breeze/shared/middleware/fastify/request-id
 * Fastify plugin that attaches a UUID requestId to each request
 * and sets the X-Request-ID response header using onRequest hook.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply, HookHandlerDoneFunction } from 'fastify';
import { v4 as uuidv4 } from 'uuid';

/**
 * Registers the request ID hook on a Fastify instance.
 * If the incoming request has an X-Request-ID header, it is reused.
 * Otherwise, a new UUID is generated.
 *
 * The generated ID is:
 * - Stored as `request.id` (Fastify's built-in ID field).
 * - Set as the `X-Request-ID` response header.
 *
 * @param fastify - The Fastify instance to register the hook on.
 *
 * @example
 * ```typescript
 * import Fastify from 'fastify';
 * import { registerFastifyRequestId } from '@breeze/shared/middleware/fastify';
 *
 * const app = Fastify({ genReqId: () => '' }); // Let our hook handle it
 * registerFastifyRequestId(app);
 * ```
 */
export function registerFastifyRequestId(fastify: FastifyInstance): void {
    fastify.addHook(
        'onRequest',
        (request: FastifyRequest, reply: FastifyReply, done: HookHandlerDoneFunction) => {
            const existingId = request.headers['x-request-id'];
            const requestId =
                typeof existingId === 'string' && existingId.length > 0 ? existingId : uuidv4();

            // Override Fastify's internal request ID
            (request as FastifyRequest & { id: string }).id = requestId;

            void reply.header('X-Request-ID', requestId);

            done();
        },
    );
}
