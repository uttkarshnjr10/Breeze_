/**
 * @module @breeze/api-gateway/schema/type-defs
 * Loads the .graphql schema file and converts it into an executable schema
 * with the @auth directive transformer applied.
 */

import fs from 'node:fs';
import path from 'node:path';
import { makeExecutableSchema } from '@graphql-tools/schema';
import type { IResolvers } from '@graphql-tools/utils';
import type { GraphQLSchema } from 'graphql';
import { authDirectiveTransformer } from '../directives/auth.directive.js';
import type { AuthGrpcClient } from '../grpc/auth.grpc-client.js';

/**
 * Loads the GraphQL schema from schema.graphql and applies directive transformers.
 *
 * @param resolvers - Merged resolver map.
 * @param authClient - gRPC client for @auth directive validation.
 * @returns Executable GraphQL schema with directives applied.
 */
export function buildSchema(
    resolvers: IResolvers,
    authClient: AuthGrpcClient,
): GraphQLSchema {
    const schemaPath = path.resolve(process.cwd(), 'services/api-gateway/src/schema/schema.graphql');
    const typeDefs = fs.readFileSync(schemaPath, 'utf-8');

    let schema = makeExecutableSchema({
        typeDefs,
        resolvers,
    });

    // Apply @auth directive transformer
    schema = authDirectiveTransformer(schema, authClient);

    return schema;
}
