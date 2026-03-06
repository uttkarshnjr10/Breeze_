/**
 * @module @breeze/shared/middleware/express/error-handler
 * Global Express error handler for the Breeze platform.
 * Routes BreezeError subtypes to structured JSON responses.
 * Non-operational errors return 500 and trigger alert-worthy logs.
 */

import type { Request, Response, NextFunction } from 'express';
import { BreezeError } from '../../errors/index.js';
import { ErrorCode, type ErrorResponse } from '../../types/index.js';

/**
 * Express request extended with requestId and traceId.
 */
interface BreezeRequest extends Request {
    requestId?: string;
    traceId?: string;
}

/**
 * Global Express error handler middleware.
 * Must be registered after all routes: `app.use(expressErrorHandler)`.
 *
 * - BreezeError instances → structured JSON with correct status code.
 * - Non-operational / unknown errors → 500 + full stack logged as ALERT.
 * - Always includes requestId and traceId in the response envelope.
 *
 * @param err - The thrown error.
 * @param req - Express request object.
 * @param res - Express response object.
 * @param _next - Express next function (required for Express to recognize this as error middleware).
 */
export function expressErrorHandler(
    err: Error,
    req: BreezeRequest,
    res: Response,
    _next: NextFunction,
): void {
    const requestId = req.requestId ?? 'unknown';
    const traceId = req.traceId ?? 'unknown';

    if (err instanceof BreezeError && err.isOperational) {
        // Operational error — expected, structured response
        const response: ErrorResponse = {
            success: false,
            error: {
                code: err.code,
                message: err.message,
                requestId,
                traceId,
                metadata: err.metadata,
            },
        };

        res.status(err.statusCode).json(response);
        return;
    }

    // Non-operational error — programmer error or unexpected failure
    // Log the full stack trace for alerting
    console.error('[ALERT] Non-operational error:', {
        requestId,
        traceId,
        error: err.message,
        stack: err.stack,
        url: req.originalUrl,
        method: req.method,
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

    res.status(500).json(response);
}
