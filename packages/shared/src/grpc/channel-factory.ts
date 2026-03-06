/**
 * @module @breeze/shared/grpc
 * gRPC channel factory with Kubernetes-optimized keepalive settings.
 * Prevents silent connection drops in containerized environments.
 */

import * as grpc from '@grpc/grpc-js';

/** Default gRPC channel options optimized for Kubernetes environments. */
const K8S_CHANNEL_OPTIONS: Record<string, number> = {
    // Send keepalive pings every 30 seconds
    'grpc.keepalive_time_ms': 30000,
    // Wait 10 seconds for a keepalive response before closing the connection
    'grpc.keepalive_timeout_ms': 10000,
    // Allow keepalive pings even when there are no active calls
    'grpc.keepalive_permit_without_calls': 1,
    // Allow unlimited pings without data (required for long-idle connections)
    'grpc.http2.max_pings_without_data': 0,
    // Maximum message size: 50MB (for large route graph responses)
    'grpc.max_receive_message_length': 50 * 1024 * 1024,
    'grpc.max_send_message_length': 50 * 1024 * 1024,
};

/**
 * Creates a gRPC channel with Kubernetes-optimized keepalive settings.
 * These settings prevent silent connection drops caused by:
 * - AWS/GCP load balancer idle timeouts
 * - Kubernetes pod rescheduling
 * - Network partitions in overlay networks
 *
 * @param host - The hostname or IP of the gRPC server.
 * @param port - The port of the gRPC server.
 * @param useTls - Whether to use TLS. Defaults to false (insecure for in-cluster communication).
 * @returns A configured gRPC ChannelCredentials and options tuple.
 *
 * @example
 * ```typescript
 * const { credentials, options } = createGrpcChannel('auth-service', 50051);
 * // Use with a generated gRPC client:
 * // const client = new AuthServiceClient('auth-service:50051', credentials, options);
 * ```
 */
export function createGrpcChannel(
    host: string,
    port: number,
    useTls: boolean = false,
): {
    address: string;
    credentials: grpc.ChannelCredentials;
    options: Record<string, number>;
} {
    const address = `${host}:${port}`;
    const credentials = useTls
        ? grpc.credentials.createSsl()
        : grpc.credentials.createInsecure();

    return {
        address,
        credentials,
        options: { ...K8S_CHANNEL_OPTIONS },
    };
}
