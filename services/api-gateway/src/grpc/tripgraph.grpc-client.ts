/**
 * @module @breeze/api-gateway/grpc/tripgraph-client
 * gRPC client for the TripGraph Service.
 * searchRoutes: 15-second deadline (routing is compute-intensive).
 */

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import path from 'node:path';
import { createGrpcChannel, ServiceUnavailableError } from '@breeze/shared';

// ─── Proto Loading ─────────────────────────────────────────────

const PROTO_PATH = path.resolve(process.cwd(), 'packages/proto/tripgraph.proto');

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

/** Location input for search requests. */
export interface GrpcLocation {
    readonly latitude: number;
    readonly longitude: number;
    readonly address?: string | undefined;
}

/** Route preferences for search. */
export interface GrpcRoutePreferences {
    readonly optimizeFor?: number | undefined;
    readonly excludedModes?: number[] | undefined;
    readonly maxTransfers?: number | undefined;
    readonly maxWalkingKm?: number | undefined;
    readonly maxBudgetInr?: number | undefined;
    readonly wheelchairAccessible?: boolean | undefined;
    readonly womenOnlyCoach?: boolean | undefined;
}

/** Search routes request. */
export interface SearchRoutesRequest {
    readonly origin: GrpcLocation;
    readonly destination: GrpcLocation;
    readonly departureTime: string;
    readonly preferences?: GrpcRoutePreferences | undefined;
    readonly maxResults?: number | undefined;
}

/** Route summary from gRPC response. */
export interface GrpcRouteSummary {
    readonly totalDurationMinutes: number;
    readonly totalDistanceKm: number;
    readonly totalCostInr: number;
    readonly transferCount: number;
    readonly walkingDistanceKm: number;
}

/** Trip leg from gRPC response. */
export interface GrpcTripLeg {
    readonly legId: string;
    readonly mode: number;
    readonly origin: { name: string; location: GrpcLocation };
    readonly destination: { name: string; location: GrpcLocation };
    readonly departureTime: string;
    readonly arrivalTime: string;
    readonly durationMinutes: number;
    readonly distanceKm: number;
    readonly estimatedCostInr: number;
    readonly operator: string;
}

/** Route option from gRPC response. */
export interface GrpcRouteOption {
    readonly routeId: string;
    readonly legs: GrpcTripLeg[];
    readonly summary: GrpcRouteSummary;
    readonly confidenceScore: number;
    readonly warnings: string[];
}

/** Search routes response. */
export interface SearchRoutesResponse {
    readonly routes: GrpcRouteOption[];
    readonly computedAt: string;
}

// ─── Client ────────────────────────────────────────────────────

/**
 * gRPC client for the TripGraph Service.
 * Wraps SearchRoutes RPC with a 15-second deadline.
 */
export class TripGraphGrpcClient {
    private readonly client: grpc.Client;

    /**
     * @param host - TripGraph Service gRPC hostname.
     * @param port - TripGraph Service gRPC port.
     */
    constructor(host: string, port: number) {
        const channel = createGrpcChannel(host, port);

        const tripgraphPackage = grpcObject['breeze'] as Record<string, Record<string, unknown>>;
        const tripgraphProto = tripgraphPackage['tripgraph'] as Record<string, unknown>;
        const TripGraphServiceDef = tripgraphProto['TripGraphService'] as typeof grpc.Client;

        this.client = new TripGraphServiceDef(
            channel.address,
            channel.credentials,
            channel.options,
        );
    }

    /**
     * Searches for multi-modal routes between origin and destination.
     * Deadline: 15 seconds (routing is compute-intensive).
     *
     * @param request - Search parameters including origin, destination, time.
     * @returns Route options with legs, summaries, and confidence scores.
     * @throws ServiceUnavailableError on deadline exceeded or connection failure.
     */
    async searchRoutes(request: SearchRoutesRequest): Promise<SearchRoutesResponse> {
        return new Promise<SearchRoutesResponse>((resolve, reject) => {
            const deadline = new Date(Date.now() + 15000);

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call
            (this.client as unknown as { searchRoutes: Function })['searchRoutes'](
                request,
                { deadline },
                (error: grpc.ServiceError | null, response: SearchRoutesResponse) => {
                    if (error) {
                        if (
                            error.code === grpc.status.DEADLINE_EXCEEDED ||
                            error.code === grpc.status.UNAVAILABLE
                        ) {
                            reject(
                                new ServiceUnavailableError('TripGraph Service unavailable', {
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
