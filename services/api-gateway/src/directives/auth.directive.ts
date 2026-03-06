/**
 * @module @breeze/api-gateway/directives/auth
 * @auth directive transformer using @graphql-tools/utils mapSchema.
 * Validates JWT via gRPC call to Auth Service — AT MOST ONCE per HTTP request.
 * Result is cached on context.authPayload for subsequent field resolutions.
 */

import { mapSchema, getDirective, MapperKind } from '@graphql-tools/utils';
import { defaultFieldResolver, type GraphQLSchema } from 'graphql';
import { GraphQLError } from 'graphql';
import type { AuthGrpcClient, ValidateTokenResult } from '../grpc/auth.grpc-client.js';

// ─── Types ─────────────────────────────────────────────────────

/** GraphQL context shape expected by the @auth directive. */
export interface AuthContext {
    req: { headers: Record<string, string | string[] | undefined> };
    res: { setHeader(name: string, value: string): void };
    /** Cached auth payload — set once per HTTP request. */
    authPayload?: ValidateTokenResult | undefined;
    /** Authenticated user ID. */
    userId?: string | undefined;
}

// ─── Directive Transformer ─────────────────────────────────────

/**
 * Creates a schema transformer that enforces the @auth directive.
 * On each @auth-annotated field:
 *   1. Extracts Bearer token from context.req.headers.authorization
 *   2. Calls authGrpcClient.validateToken (ONCE per request, cached on context)
 *   3. Checks role if specified in @auth(role: "...")
 *   4. Attaches context.userId
 *
 * @param schema - The executable GraphQL schema.
 * @param authClient - gRPC client for the Auth Service.
 * @returns Transformed schema with @auth enforcement.
 */
export function authDirectiveTransformer(
    schema: GraphQLSchema,
    authClient: AuthGrpcClient,
): GraphQLSchema {
    return mapSchema(schema, {
        [MapperKind.OBJECT_FIELD]: (fieldConfig) => {
            const authDirective = getDirective(schema, fieldConfig, 'auth')?.[0] as
                | { role?: string | undefined }
                | undefined;

            if (!authDirective) {
                return fieldConfig;
            }

            const requiredRole = authDirective.role;
            const originalResolve = fieldConfig.resolve ?? defaultFieldResolver;

            fieldConfig.resolve = async (source, args, context: AuthContext, info) => {
                // ─── 1. Check cached auth payload first ────────────
                if (!context.authPayload) {
                    const authHeader = context.req.headers['authorization'];
                    const headerValue = Array.isArray(authHeader) ? authHeader[0] : authHeader;

                    if (!headerValue || typeof headerValue !== 'string') {
                        throw new GraphQLError('Authentication required', {
                            extensions: { code: 'UNAUTHENTICATED' },
                        });
                    }

                    const parts = headerValue.split(' ');
                    if (parts.length !== 2 || parts[0] !== 'Bearer' || !parts[1]) {
                        throw new GraphQLError('Invalid Authorization header format', {
                            extensions: { code: 'UNAUTHENTICATED' },
                        });
                    }

                    // ─── 2. Single gRPC call, cached on context ──────
                    const result = await authClient.validateToken(parts[1]);

                    if (!result.valid) {
                        throw new GraphQLError('Invalid or expired token', {
                            extensions: { code: 'UNAUTHENTICATED' },
                        });
                    }

                    context.authPayload = result;
                    context.userId = result.userId;
                }

                // ─── 3. Role check ─────────────────────────────────
                if (requiredRole && !context.authPayload.roles.includes(requiredRole)) {
                    throw new GraphQLError(`Insufficient permissions. Required role: ${requiredRole}`, {
                        extensions: { code: 'FORBIDDEN' },
                    });
                }

                return originalResolve(source, args, context, info);
            };

            return fieldConfig;
        },
    });
}
