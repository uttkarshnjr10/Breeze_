/**
 * @module @breeze/api-gateway/grpc/auth-client
 * gRPC client for the Auth Service.
 * validateToken: 3-second deadline. getUserProfile: 5-second deadline.
 * Uses createGrpcChannel from @breeze/shared for K8s-optimized keepalive.
 */

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import path from 'node:path';
import { createGrpcChannel } from '@breeze/shared';
import { ServiceUnavailableError } from '@breeze/shared';

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

/** Result of ValidateToken gRPC call. */
export interface ValidateTokenResult {
    readonly valid: boolean;
    readonly userId: string;
    readonly email: string;
    readonly roles: string[];
    readonly expiresAt: string;
}

/** Result of GetUserProfile gRPC call. */
export interface UserProfile {
    readonly userId: string;
    readonly email: string;
    readonly displayName: string;
    readonly avatarUrl: string;
    readonly roles: string[];
    readonly createdAt: string;
    readonly updatedAt: string;
}

// ─── Client ────────────────────────────────────────────────────

/**
 * gRPC client for the Auth Service.
 * Wraps ValidateToken and GetUserProfile RPCs with deadlines.
 */
export class AuthGrpcClient {
    private readonly client: grpc.Client;

    /**
     * @param host - Auth Service gRPC hostname.
     * @param port - Auth Service gRPC port.
     */
    constructor(host: string, port: number) {
        const channel = createGrpcChannel(host, port);

        const authPackage = grpcObject['breeze'] as Record<string, Record<string, unknown>>;
        const authProto = authPackage['auth'] as Record<string, unknown>;
        const AuthServiceDef = authProto['AuthService'] as typeof grpc.Client;

        this.client = new AuthServiceDef(channel.address, channel.credentials, channel.options);
    }

    /**
     * Validates a JWT token via the Auth Service gRPC endpoint.
     * Deadline: 3 seconds.
     *
     * @param token - JWT access token string.
     * @returns Validation result with userId, email, roles.
     * @throws ServiceUnavailableError on deadline exceeded or connection failure.
     */
    async validateToken(token: string): Promise<ValidateTokenResult> {
        return new Promise<ValidateTokenResult>((resolve, reject) => {
            const deadline = new Date(Date.now() + 3000);

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call
            (this.client as unknown as { validateToken: Function })['validateToken'](
                { token },
                { deadline },
                (error: grpc.ServiceError | null, response: ValidateTokenResult) => {
                    if (error) {
                        if (
                            error.code === grpc.status.DEADLINE_EXCEEDED ||
                            error.code === grpc.status.UNAVAILABLE
                        ) {
                            reject(
                                new ServiceUnavailableError('Auth Service unavailable', {
                                    grpcCode: error.code,
                                    details: error.details,
                                }),
                            );
                            return;
                        }
                        reject(error);
                        return;
                    }
                    resolve(response);
                },
            );
        });
    }

    /**
     * Retrieves a user profile from the Auth Service.
     * Deadline: 5 seconds.
     *
     * @param userId - PostgreSQL UUID of the user.
     * @returns User profile data.
     * @throws ServiceUnavailableError on deadline exceeded or connection failure.
     */
    async getUserProfile(userId: string): Promise<UserProfile> {
        return new Promise<UserProfile>((resolve, reject) => {
            const deadline = new Date(Date.now() + 5000);

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call
            (this.client as unknown as { getUserProfile: Function })['getUserProfile'](
                { userId },
                { deadline },
                (error: grpc.ServiceError | null, response: UserProfile) => {
                    if (error) {
                        if (
                            error.code === grpc.status.DEADLINE_EXCEEDED ||
                            error.code === grpc.status.UNAVAILABLE
                        ) {
                            reject(
                                new ServiceUnavailableError('Auth Service unavailable', {
                                    grpcCode: error.code,
                                    details: error.details,
                                }),
                            );
                            return;
                        }
                        reject(error);
                        return;
                    }
                    resolve(response);
                },
            );
        });
    }

    /** Closes the gRPC client connection. */
    close(): void {
        this.client.close();
    }
}
