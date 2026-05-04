/**
 * RateLimitService — fixed-window rate limiter, atomic per IP.
 *
 * Backed by the `RateLimitDO` Durable Object (sharded by IP via
 * `idFromName(key)`), so concurrent requests from the same client
 * serialize through one isolate. This replaces the prior KV-backed
 * implementation that had a read-modify-write race: two parallel
 * requests could both observe `count = 0` and both pass.
 *
 * Failure mode: if the DO call throws (binding misconfig, cold-start
 * timeout, etc.), we fail open — same as the old KV version did on KV
 * 429s. A rate-limit outage shouldn't take down the whole API.
 */
import type { RateLimitDO } from '../agents/RateLimitDO';

export class RateLimitService {
  private namespace: DurableObjectNamespace<RateLimitDO>;

  constructor(namespace: DurableObjectNamespace<RateLimitDO>) {
    this.namespace = namespace;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static fromEnv(env: any): RateLimitService {
    return new RateLimitService(env.RATE_LIMIT);
  }

  /**
   * @param key Client identifier — usually an IP address. Determines DO
   *            sharding via `idFromName`, so the same key always hits
   *            the same isolate.
   * @param limit Max requests in the window.
   * @param windowSeconds Window length.
   * @param endpoint Optional per-endpoint sub-bucket (e.g. `'auth:session'`).
   *                 Stored as a separate counter inside the per-IP DO.
   */
  async checkLimit(
    key: string,
    limit: number,
    windowSeconds: number,
    endpoint?: string,
  ): Promise<boolean> {
    try {
      const id = this.namespace.idFromName(key);
      const stub = this.namespace.get(id);
      return await stub.checkLimit(endpoint ?? 'default', limit, windowSeconds);
    } catch (error) {
      console.warn(`[RateLimitService] DO call failed for ${key}/${endpoint ?? 'default'}:`, error);
      return true;
    }
  }
}
