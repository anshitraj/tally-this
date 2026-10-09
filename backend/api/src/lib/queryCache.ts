/**
 * Lightweight in-process cache for read-heavy API endpoints.
 * Stores results in a Map with TTL-based invalidation.
 * No Redis needed — process memory is fine for single-server dev/staging.
 *
 * Usage:
 *   import { queryCache } from "../lib/queryCache";
 *   const data = await queryCache.get("overview:company:94", 30, () => db.select()...);
 */

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

class QueryCache {
  private store = new Map<string, CacheEntry<unknown>>();
  private maxEntries: number;

  constructor(maxEntries = 500) {
    this.maxEntries = maxEntries;
    // Evict expired entries every 60s
    const timer = setInterval(() => this.evict(), 60_000);
    timer.unref();
  }

  /**
   * Get a cached value or compute it.
   * @param key      Cache key (should include company_id to be tenant-safe)
   * @param ttlSecs  How long to cache (seconds)
   * @param fn       Async function to compute the value on cache miss
   */
  async get<T>(key: string, ttlSecs: number, fn: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const entry = this.store.get(key) as CacheEntry<T> | undefined;
    if (entry && entry.expiresAt > now) {
      return entry.value;
    }
    const value = await fn();
    this.store.set(key, { value, expiresAt: now + ttlSecs * 1000 });
    this.evictIfOverfull();
    return value;
  }

  /** Invalidate a specific key or all keys matching a prefix. */
  invalidate(keyOrPrefix: string): void {
    for (const k of this.store.keys()) {
      if (k === keyOrPrefix || k.startsWith(keyOrPrefix + ":")) {
        this.store.delete(k);
      }
    }
  }

  /** Invalidate all keys for a specific company. */
  invalidateCompany(companyId: string | number): void {
    this.invalidate(`company:${companyId}`);
  }

  private evict(): void {
    const now = Date.now();
    for (const [k, v] of this.store.entries()) {
      if (v.expiresAt <= now) this.store.delete(k);
    }
  }

  private evictIfOverfull(): void {
    if (this.store.size > this.maxEntries) {
      // Delete oldest entries (insertion order)
      const deleteCount = Math.floor(this.maxEntries * 0.2);
      let i = 0;
      for (const k of this.store.keys()) {
        if (i++ >= deleteCount) break;
        this.store.delete(k);
      }
    }
  }
}

// Singleton — shared across all requests in the same process
export const queryCache = new QueryCache();
