/**
 * @module @breeze/shared/errors
 * Custom error class hierarchy for the Breeze platform.
 * All operational errors extend BreezeError and produce clean JSON responses.
 */

import { ErrorCode } from '../types/index.js';

/**
 * Base error class for all Breeze platform errors.
 * Provides structured error responses suitable for API consumers.
 */
export class BreezeError extends Error {
    /** Canonical error code from the ErrorCode enum. */
    public readonly code: ErrorCode;
    /** HTTP status code associated with this error. */
    public readonly statusCode: number;
    /** Whether this error is operational (expected) vs programmer error. */
    public readonly isOperational: boolean;
    /** Additional metadata to include in the error response. */
    public readonly metadata: Record<string, unknown>;

    /**
     * @param message - Human-readable error message.
     * @param code - Canonical error code.
     * @param statusCode - HTTP status code.
     * @param isOperational - True if this is an expected operational error.
     * @param metadata - Additional context for the error.
     */
    constructor(
        message: string,
        code: ErrorCode = ErrorCode.INTERNAL_ERROR,
        statusCode: number = 500,
        isOperational: boolean = true,
        metadata: Record<string, unknown> = {},
    ) {
        super(message);
        this.name = this.constructor.name;
        this.code = code;
        this.statusCode = statusCode;
        this.isOperational = isOperational;
        this.metadata = metadata;

        // Maintains proper prototype chain for instanceof checks
        Object.setPrototypeOf(this, new.target.prototype);

        // Captures stack trace excluding the constructor
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, this.constructor);
        }
    }

    /**
     * Produces a clean JSON response object. Never exposes stack traces.
     * @returns Structured error object safe for API responses.
     */
    toJSON(): {
        code: ErrorCode;
        message: string;
        statusCode: number;
        metadata: Record<string, unknown>;
    } {
        return {
            code: this.code,
            message: this.message,
            statusCode: this.statusCode,
            metadata: this.metadata,
        };
    }
}

/**
 * Thrown when request validation fails (400).
 */
export class ValidationError extends BreezeError {
    /**
     * @param message - Description of what failed validation.
     * @param metadata - Field-level error details.
     */
    constructor(message: string, metadata: Record<string, unknown> = {}) {
        super(message, ErrorCode.VALIDATION_ERROR, 400, true, metadata);
    }
}

/**
 * Thrown when a requested resource is not found (404).
 */
export class NotFoundError extends BreezeError {
    /**
     * @param message - Description of the missing resource.
     * @param metadata - Additional context (e.g., resource type, ID).
     */
    constructor(message: string, metadata: Record<string, unknown> = {}) {
        super(message, ErrorCode.NOT_FOUND, 404, true, metadata);
    }
}

/**
 * Thrown when authentication is required but missing or invalid (401).
 */
export class UnauthorizedError extends BreezeError {
    /**
     * @param message - Description of the authentication failure.
     * @param metadata - Additional context.
     */
    constructor(message: string = 'Authentication required', metadata: Record<string, unknown> = {}) {
        super(message, ErrorCode.UNAUTHORIZED, 401, true, metadata);
    }
}

/**
 * Thrown when the user lacks permission for the requested action (403).
 */
export class ForbiddenError extends BreezeError {
    /**
     * @param message - Description of what is forbidden.
     * @param metadata - Additional context (e.g., required role).
     */
    constructor(
        message: string = 'Insufficient permissions',
        metadata: Record<string, unknown> = {},
    ) {
        super(message, ErrorCode.FORBIDDEN, 403, true, metadata);
    }
}

/**
 * Thrown when the client has exceeded the rate limit (429).
 */
export class RateLimitedError extends BreezeError {
    /**
     * @param message - Rate limit description.
     * @param metadata - Additional context (e.g., retryAfterSeconds).
     */
    constructor(message: string = 'Rate limit exceeded', metadata: Record<string, unknown> = {}) {
        super(message, ErrorCode.RATE_LIMITED, 429, true, metadata);
    }
}

/**
 * Thrown when a downstream service is unavailable (503).
 */
export class ServiceUnavailableError extends BreezeError {
    /**
     * @param message - Description of which service is unavailable.
     * @param metadata - Additional context (e.g., service name, retry hint).
     */
    constructor(
        message: string = 'Service temporarily unavailable',
        metadata: Record<string, unknown> = {},
    ) {
        super(message, ErrorCode.SERVICE_UNAVAILABLE, 503, true, metadata);
    }
}

/**
 * Thrown when a resource conflict occurs (409).
 */
export class ConflictError extends BreezeError {
    /**
     * @param message - Description of the conflict.
     * @param metadata - Additional context (e.g., conflicting field).
     */
    constructor(message: string, metadata: Record<string, unknown> = {}) {
        super(message, ErrorCode.CONFLICT, 409, true, metadata);
    }
}
