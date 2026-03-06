/**
 * @module @breeze/auth-service/grpc
 * gRPC server for internal auth service communication.
 * Implements ValidateToken and GetUserProfile from auth.proto.
 * ValidateToken never throws — returns { valid: false } on any error.
 */

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import path from 'node:path';
import type { JWTService } from '../services/jwt.service.js';
import type { UserRepository } from '../repositories/user.repository.js';

// ─── Proto Loading ─────────────────────────────────────────────

const PROTO_PATH = path.resolve(process.cwd(), 'packages/proto/auth.proto');

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
    includeDirs: [path.resolve(process.cwd(), 'packages/proto')],
});

const grpcObject = grpc.loadPackageDefinition(packageDefinition);

// ─── Types ─────────────────────────────────────────────────────

interface ValidateTokenRequest {
    readonly token: string;
}

interface ValidateTokenResponse {
    valid: boolean;
    userId: string;
    email: string;
    roles: string[];
    expiresAt: string;
}

interface GetUserProfileRequest {
    readonly userId: string;
}

interface GetUserProfileResponse {
    userId: string;
    email: string;
    displayName: string;
    phone: string;
    avatarUrl: string;
    roles: string[];
    emergencyContacts: Array<{
        name: string;
        phone: string;
        relationship: string;
    }>;
    createdAt: string;
    updatedAt: string;
}

type GrpcCallback<T> = (error: grpc.ServiceError | null, response?: T) => void;

// ─── Server Factory ────────────────────────────────────────────

/**
 * Creates and starts a gRPC server for internal auth service communication.
 * Uses insecure credentials — intended for in-cluster communication only.
 *
 * @param port - Port to listen on.
 * @param jwtService - JWTService for token validation.
 * @param userRepository - UserRepository for profile lookups.
 * @returns The started gRPC server instance.
 */
export async function startGrpcServer(
    port: number,
    jwtService: JWTService,
    userRepository: UserRepository,
): Promise<grpc.Server> {
    const server = new grpc.Server();

    // Extract the AuthService definition from the loaded proto
    const authPackage = grpcObject['breeze'] as Record<string, Record<string, unknown>>;
    const authProto = authPackage['auth'] as Record<string, unknown>;
    const AuthServiceDef = authProto['AuthService'] as grpc.ServiceClientConstructor;

    server.addService(AuthServiceDef.service, {
        /**
         * ValidateToken: verifies a JWT access token.
         * NEVER throws — returns { valid: false } on any error.
         */
        validateToken(
            call: grpc.ServerUnaryCall<ValidateTokenRequest, ValidateTokenResponse>,
            callback: GrpcCallback<ValidateTokenResponse>,
        ): void {
            try {
                const payload = jwtService.verifyAccessToken(call.request.token);

                callback(null, {
                    valid: true,
                    userId: payload.userId,
                    email: payload.email,
                    roles: payload.roles,
                    expiresAt: '', // Not exposed in access token for security
                });
            } catch {
                // Never throw from gRPC handler — return invalid response
                callback(null, {
                    valid: false,
                    userId: '',
                    email: '',
                    roles: [],
                    expiresAt: '',
                });
            }
        },

        /**
         * GetUserProfile: retrieves a user profile by ID.
         */
        async getUserProfile(
            call: grpc.ServerUnaryCall<GetUserProfileRequest, GetUserProfileResponse>,
            callback: GrpcCallback<GetUserProfileResponse>,
        ): Promise<void> {
            try {
                const user = await userRepository.findById(call.request.userId);

                if (!user) {
                    const error: Partial<grpc.ServiceError> = {
                        code: grpc.status.NOT_FOUND,
                        message: 'User not found',
                    };
                    callback(error as grpc.ServiceError);
                    return;
                }

                const contacts = await userRepository.getEmergencyContacts(user.id);

                callback(null, {
                    userId: user.id,
                    email: user.email,
                    displayName: user.displayName,
                    phone: '',
                    avatarUrl: user.avatarUrl ?? '',
                    roles: user.roles,
                    emergencyContacts: contacts.map((c) => ({
                        name: c.name,
                        phone: c.phone,
                        relationship: c.relation,
                    })),
                    createdAt: user.createdAt.toISOString(),
                    updatedAt: user.updatedAt.toISOString(),
                });
            } catch (error: unknown) {
                const grpcError: Partial<grpc.ServiceError> = {
                    code: grpc.status.INTERNAL,
                    message: error instanceof Error ? error.message : 'Internal error',
                };
                callback(grpcError as grpc.ServiceError);
            }
        },
    });

    return new Promise<grpc.Server>((resolve, reject) => {
        server.bindAsync(
            `0.0.0.0:${port}`,
            grpc.ServerCredentials.createInsecure(),
            (error: Error | null) => {
                if (error) {
                    reject(error);
                    return;
                }
                console.log(`[auth-service] gRPC server listening on port ${port}`);
                resolve(server);
            },
        );
    });
}
