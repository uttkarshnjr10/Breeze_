/**
 * @module @breeze/shared/utils/lru-cache
 * Typed LRU cache wrapper around lru-cache v10.
 * All services that need L1 in-process caching MUST use this wrapper.
 */

import { LRUCache } from 'lru-cache';

/**
 * Typed interface for the service-level LRU cache.
 */
export interface ServiceCache<T extends NonNullable<unknown>> {
    /**
     * Retrieves a value from the cache.
     * @param key - Cache key.
     * @returns The cached value, or undefined if not found or expired.
     */
    get(key: string): T | undefined;

    /**
     * Stores a value in the cache.
     * @param key - Cache key.
     * @param value - Value to cache.
     */
    set(key: string, value: T): void;

    /**
     * Removes a value from the cache.
     * @param key - Cache key.
     * @returns True if the key existed and was removed.
     */
    delete(key: string): boolean;

    /**
     * Clears all entries from the cache.
     */
    clear(): void;

    /** The human-readable name of this cache instance. */
    readonly name: string;

    /** Current number of items in the cache. */
    readonly size: number;
}

/**
 * Creates a typed, named LRU cache instance for service-level in-process caching.
 * This is the single canonical L1 cache factory for the entire Breeze platform.
 *
 * @param name - Human-readable name for this cache (used in metrics/logging).
 * @param maxSize - Maximum number of items to store.
 * @param ttlSeconds - Time-to-live for each entry in seconds.
 * @returns A typed ServiceCache instance.
 *
 * @example
 * ```typescript
 * const userCache = createServiceCache<UserProfile>('user-profiles', 1000, 300);
 * userCache.set('user:123', profile);
 * const cached = userCache.get('user:123');
 * ```
 */
export function createServiceCache<T extends NonNullable<unknown>>(
    name: string,
    maxSize: number,
    ttlSeconds: number,
): ServiceCache<T> {
    const cache = new LRUCache<string, T>({
        max: maxSize,
        ttl: ttlSeconds * 1000,
        updateAgeOnGet: true,
        updateAgeOnHas: false,
    });

    return {
        get(key: string): T | undefined {
            return cache.get(key);
        },

        set(key: string, value: T): void {
            cache.set(key, value);
        },

        delete(key: string): boolean {
            return cache.delete(key);
        },

        clear(): void {
            cache.clear();
        },

        get name(): string {
            return name;
        },

        get size(): number {
            return cache.size;
        },
    };
}
