/**
 * @module @breeze/shared/redis
 * Redis client factory with typed wrappers and L1/L2 caching strategy.
 * All Redis connection failures throw ServiceUnavailableError.
 */

import Redis from 'ioredis';
import { ServiceUnavailableError } from '../errors/index.js';
import { createServiceCache, type ServiceCache } from '../utils/lru-cache.js';

// ─── Typed Redis Client ────────────────────────────────────────

/** Typed wrapper around an ioredis client with JSON-aware methods. */
export interface TypedRedisClient {
    /**
     * Retrieves and parses a JSON value from Redis.
     * @param key - The Redis key.
     * @returns The parsed value, or null if the key does not exist.
     */
    getJSON<T>(key: string): Promise<T | null>;

    /**
     * Serializes and stores a JSON value in Redis.
     * @param key - The Redis key.
     * @param value - The value to store.
     */
    setJSON<T>(key: string, value: T): Promise<void>;

    /**
     * Serializes and stores a JSON value in Redis with an expiration time.
     * @param key - The Redis key.
     * @param value - The value to store.
     * @param ttlSeconds - Time-to-live in seconds.
     */
    setExJSON<T>(key: string, value: T, ttlSeconds: number): Promise<void>;

    /**
     * Deletes a key from Redis.
     * @param key - The Redis key to delete.
     * @returns The number of keys removed.
     */
    deleteKey(key: string): Promise<number>;

    /**
     * Checks if a key exists in Redis.
     * @param key - The Redis key.
     * @returns True if the key exists.
     */
    exists(key: string): Promise<boolean>;

    /**
     * Increments a numeric key by the given amount.
     * @param key - The Redis key.
     * @param increment - Amount to increment by.
     * @returns The new value after increment.
     */
    incrBy(key: string, increment: number): Promise<number>;

    /**
     * Adds a member to a Redis set.
     * @param key - The set key.
     * @param member - The member to add.
     * @returns The number of elements added.
     */
    sAdd(key: string, member: string): Promise<number>;

    /**
     * Checks if a member exists in a Redis set.
     * @param key - The set key.
     * @param member - The member to check.
     * @returns True if the member is in the set.
     */
    sIsMember(key: string, member: string): Promise<boolean>;

    /**
     * Adds a member to a sorted set with a score.
     * @param key - The sorted set key.
     * @param score - The score for the member.
     * @param member - The member to add.
     * @returns The number of elements added.
     */
    zAdd(key: string, score: number, member: string): Promise<number>;

    /**
     * Removes members in a sorted set within the given score range.
     * @param key - The sorted set key.
     * @param min - Minimum score (inclusive).
     * @param max - Maximum score (inclusive).
     * @returns The number of elements removed.
     */
    zRemRangeByScore(key: string, min: number, max: number): Promise<number>;

    /**
     * Returns the cardinality (number of elements) of a sorted set.
     * @param key - The sorted set key.
     * @returns The number of elements in the sorted set.
     */
    zCard(key: string): Promise<number>;

    /** Disconnects the Redis client. */
    disconnect(): Promise<void>;

    /** The underlying ioredis client for advanced operations. */
    readonly raw: Redis;
}

// ─── Error Wrapper ─────────────────────────────────────────────

/**
 * Wraps a Redis operation and throws ServiceUnavailableError on connection failure.
 * @param operation - Async function containing the Redis operation.
 * @returns The result of the operation.
 */
async function withConnectionGuard<T>(operation: () => Promise<T>): Promise<T> {
    try {
        return await operation();
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Unknown Redis error';
        throw new ServiceUnavailableError(`Redis connection failure: ${message}`, {
            service: 'redis',
            originalError: message,
        });
    }
}

// ─── Factory ───────────────────────────────────────────────────

/**
 * Factory for creating typed Redis client instances.
 */
export class RedisFactory {
    /**
     * Creates a typed Redis client wrapper connected to the given URL.
     * @param url - Redis connection URL (e.g., 'redis://localhost:6379').
     * @returns A TypedRedisClient wrapping the ioredis connection.
     */
    static createClient(url: string): TypedRedisClient {
        const client = new Redis(url, {
            maxRetriesPerRequest: 3,
            retryStrategy(times: number): number | null {
                if (times > 10) {
                    return null; // Stop retrying after 10 attempts
                }
                return Math.min(times * 200, 5000);
            },
            lazyConnect: false,
            enableReadyCheck: true,
        });

        return {
            async getJSON<T>(key: string): Promise<T | null> {
                return withConnectionGuard(async () => {
                    const raw = await client.get(key);
                    if (raw === null) {
                        return null;
                    }
                    return JSON.parse(raw) as T;
                });
            },

            async setJSON<T>(key: string, value: T): Promise<void> {
                return withConnectionGuard(async () => {
                    await client.set(key, JSON.stringify(value));
                });
            },

            async setExJSON<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
                return withConnectionGuard(async () => {
                    await client.setex(key, ttlSeconds, JSON.stringify(value));
                });
            },

            async deleteKey(key: string): Promise<number> {
                return withConnectionGuard(async () => {
                    return client.del(key);
                });
            },

            async exists(key: string): Promise<boolean> {
                return withConnectionGuard(async () => {
                    const result = await client.exists(key);
                    return result === 1;
                });
            },

            async incrBy(key: string, increment: number): Promise<number> {
                return withConnectionGuard(async () => {
                    return client.incrby(key, increment);
                });
            },

            async sAdd(key: string, member: string): Promise<number> {
                return withConnectionGuard(async () => {
                    return client.sadd(key, member);
                });
            },

            async sIsMember(key: string, member: string): Promise<boolean> {
                return withConnectionGuard(async () => {
                    const result = await client.sismember(key, member);
                    return result === 1;
                });
            },

            async zAdd(key: string, score: number, member: string): Promise<number> {
                return withConnectionGuard(async () => {
                    return client.zadd(key, score, member);
                });
            },

            async zRemRangeByScore(key: string, min: number, max: number): Promise<number> {
                return withConnectionGuard(async () => {
                    return client.zremrangebyscore(key, min, max);
                });
            },

            async zCard(key: string): Promise<number> {
                return withConnectionGuard(async () => {
                    return client.zcard(key);
                });
            },

            async disconnect(): Promise<void> {
                await client.quit();
            },

            get raw(): Redis {
                return client;
            },
        };
    }
}

// ─── L1 / L2 Two-Tier Cache ───────────────────────────────────

/** Options for creating a two-tier L1 (in-process) + L2 (Redis) cache. */
export interface LruRedisCacheOptions {
    /** Maximum number of items in the L1 in-process cache. */
    readonly maxSize: number;
    /** Time-to-live for L2 (Redis) entries in seconds. */
    readonly l2TtlSeconds: number;
    /** Redis client to use for L2 caching. */
    readonly redis: TypedRedisClient;
}

/** Two-tier cache with L1 (in-process LRU) and L2 (Redis). */
export interface LruRedisCache<T extends NonNullable<unknown>> {
    /**
     * Gets a value, checking L1 first, then L2. Populates L1 on L2 hit.
     * @param key - Cache key.
     * @returns The cached value, or null if not found.
     */
    get(key: string): Promise<T | null>;

    /**
     * Stores a value in both L1 and L2.
     * @param key - Cache key.
     * @param value - The value to cache.
     */
    set(key: string, value: T): Promise<void>;

    /**
     * Deletes a value from both L1 and L2.
     * @param key - Cache key.
     */
    delete(key: string): Promise<void>;

    /**
     * Clears L1 cache. L2 keys must be invalidated separately if needed.
     */
    clearL1(): void;

    /** The L1 cache instance. */
    readonly l1: ServiceCache<T>;
}

/** L1 TTL in seconds (fixed at 60 seconds as per spec). */
const L1_TTL_SECONDS = 60;

/**
 * Creates a two-tier cache: L1 (in-process LRU, 60s TTL) + L2 (Redis, configurable TTL).
 * On L1 miss, checks L2 and populates L1. On write, updates both layers.
 *
 * @param name - Human-readable name for this cache instance.
 * @param options - Cache configuration options.
 * @returns A two-tier LruRedisCache instance.
 *
 * @example
 * ```typescript
 * const cache = createLruRedisCache<UserProfile>('user-profiles', {
 *   maxSize: 5000,
 *   l2TtlSeconds: 600,
 *   redis: redisClient,
 * });
 * await cache.set('user:123', profile);
 * const result = await cache.get('user:123');
 * ```
 */
export function createLruRedisCache<T extends NonNullable<unknown>>(
    name: string,
    options: LruRedisCacheOptions,
): LruRedisCache<T> {
    const l1 = createServiceCache<T>(name, options.maxSize, L1_TTL_SECONDS);
    const redisKeyPrefix = `breeze:cache:${name}:`;

    return {
        async get(key: string): Promise<T | null> {
            // Check L1 first
            const l1Value = l1.get(key);
            if (l1Value !== undefined) {
                return l1Value;
            }

            // L1 miss — check L2
            const l2Value = await options.redis.getJSON<T>(`${redisKeyPrefix}${key}`);
            if (l2Value !== null) {
                // Populate L1 on L2 hit
                l1.set(key, l2Value);
                return l2Value;
            }

            return null;
        },

        async set(key: string, value: T): Promise<void> {
            // Update both layers
            l1.set(key, value);
            await options.redis.setExJSON<T>(`${redisKeyPrefix}${key}`, value, options.l2TtlSeconds);
        },

        async delete(key: string): Promise<void> {
            l1.delete(key);
            await options.redis.deleteKey(`${redisKeyPrefix}${key}`);
        },

        clearL1(): void {
            l1.clear();
        },

        get l1(): ServiceCache<T> {
            return l1;
        },
    };
}
