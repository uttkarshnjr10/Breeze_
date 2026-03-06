/**
 * @module @breeze/shared/middleware/express/request-id
 * Express middleware that attaches a UUID requestId to each request
 * and sets the X-Request-ID response header.
 */

import type { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';

/**
 * Express request extended with requestId.
 */
interface BreezeRequest extends Request {
    requestId?: string;
}

/**
 * Express middleware that generates and attaches a UUID requestId.
 * If the incoming request already has an X-Request-ID header, it is reused.
 * The requestId is set on both `req.requestId` and the `X-Request-ID` response header.
 *
 * @param req - Express request object.
 * @param res - Express response object.
 * @param next - Express next function.
 */
export function requestIdMiddleware(req: BreezeRequest, res: Response, next: NextFunction): void {
    const existingId = req.headers['x-request-id'];
    const requestId = typeof existingId === 'string' && existingId.length > 0 ? existingId : uuidv4();

    req.requestId = requestId;
    res.setHeader('X-Request-ID', requestId);

    next();
}
