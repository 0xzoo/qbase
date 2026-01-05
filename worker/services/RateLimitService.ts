export class RateLimitService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private kv: any;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(kv: any) {
    this.kv = kv;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static fromEnv(env: any): RateLimitService {
    // Using KV_USER_PROFILES as a shared KV for now. 
    // Ideally, we should have a dedicated KV_RATE_LIMIT.
    return new RateLimitService(env.KV_USER_PROFILES);
  }

  /**
   * Checks if a request should be rate limited.
   * @param key Unique identifier for the client (e.g., IP address or User ID)
   * @param limit Max requests allowed in the window
   * @param windowSeconds Time window in seconds
   * @returns true if request is allowed, false if rate limited
   */
  async checkLimit(key: string, limit: number, windowSeconds: number): Promise<boolean> {
    const kvKey = `ratelimit:${key}`;

    // Get current count
    const countStr = await this.kv.get(kvKey);
    let count = countStr ? parseInt(countStr) : 0;

    if (count >= limit) {
      return false;
    }

    // Increment count
    count++;

    // Update KV
    // If it's a new key (count === 1), set the expiration
    // If it's an existing key, we just update the value but keep the TTL (approximate)
    // Cloudflare KV doesn't support "update value, keep TTL", so we might reset TTL or just set it every time.
    // Setting it every time extends the window, making it a "sliding window" of sorts if we aren't careful.
    // A simple approach for fixed window:
    // If key doesn't exist, set with TTL. If it exists, just increment (but we can't atomic increment easily without DO).
    // For simple KV rate limiting:
    // We can just set the value with the same TTL if we want a rolling window, or just set it.

    // Let's use a simple approach: Set with TTL equal to windowSeconds.
    // Wrap in try-catch to fail open if KV is rate-limited (429)
    // This prevents KV rate limits from breaking the entire app
    try {
      await this.kv.put(kvKey, count.toString(), { expirationTtl: windowSeconds });
    } catch (error) {
      // Log but don't fail the request - rate limiting becomes less accurate during KV pressure
      console.warn(`[RateLimitService] KV PUT failed for ${kvKey}:`, error);
    }

    return true;
  }
}
