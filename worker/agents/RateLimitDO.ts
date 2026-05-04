/**
 * RateLimitDO — atomic per-IP rate limiter.
 *
 * Sharded by `idFromName(ip)`, so the same client IP always lands on the
 * same DO instance. Concurrent requests from one IP serialize through
 * one isolate, eliminating the read-modify-write race that the previous
 * KV-backed implementation had (two parallel requests both reading
 * `count = 0`, both passing, both writing).
 *
 * Storage is per-endpoint inside the DO: `rl:${endpoint}` → `{ count,
 * resetAt }`. Fixed-window semantics — matches the prior KV
 * `expirationTtl` behavior. Expired entries get overwritten lazily on
 * the next request to that endpoint; no cleanup alarm needed since each
 * DO only holds a handful of (limit, period) buckets.
 *
 * The single public method `checkLimit` returns `true` if the request
 * is allowed (and the count was incremented) or `false` if the window
 * is full. The atomic guarantee comes from `blockConcurrencyWhile`,
 * which prevents the runtime from interleaving another fetch handler
 * between the storage read and write.
 */
import { DurableObject } from 'cloudflare:workers';

interface RateLimitWindow {
  count: number;
  resetAt: number; // epoch ms
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export class RateLimitDO extends DurableObject<any> {
  /**
   * @param endpoint Per-endpoint key inside this DO (the IP is implicit
   *                 in the DO id). Use a stable identifier like
   *                 `'auth:session'` or `'queries:create'`.
   * @param limit Max requests allowed in the window.
   * @param windowSeconds Window length.
   * @returns true if allowed (count incremented), false if rate limited.
   */
  async checkLimit(endpoint: string, limit: number, windowSeconds: number): Promise<boolean> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const key = `rl:${endpoint}`;
      const now = Date.now();
      const entry = await this.ctx.storage.get<RateLimitWindow>(key);

      if (!entry || entry.resetAt <= now) {
        // Expired or first hit — open a fresh window.
        await this.ctx.storage.put<RateLimitWindow>(key, {
          count: 1,
          resetAt: now + windowSeconds * 1000,
        });
        return true;
      }

      if (entry.count >= limit) {
        return false;
      }

      await this.ctx.storage.put<RateLimitWindow>(key, {
        count: entry.count + 1,
        resetAt: entry.resetAt,
      });
      return true;
    });
  }
}
