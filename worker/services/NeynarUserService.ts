/**
 * NeynarUserService — Neynar user lookup with KV score caching.
 *
 * Deliberately Neynar-pinned (not routed): its consumers — the anon-cast
 * score gate and the quiz airdrops — read `score`, which only Neynar has.
 * Profile reads that do not need the score go through `initFarcasterData`.
 */

import { NeynarDataProvider } from './farcaster/NeynarDataProvider';
import type { FarcasterUser } from './farcaster/FarcasterDataProvider';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

/** Kept as an alias so existing consumers keep their type name. */
export type NeynarUser = FarcasterUser;

const SCORE_CACHE_TTL = 86400; // 24 hours

/**
 * Fetch a Neynar user by FID (raw API call, no cache).
 */
export async function fetchNeynarUser(env: Env, fid: number): Promise<NeynarUser | null> {
  const apiKey = env.NEYNAR_API_KEY;
  if (!apiKey) {
    console.error('[NeynarUserService] NEYNAR_API_KEY missing');
    return null;
  }
  try {
    const [user] = await new NeynarDataProvider({ apiKey }).getUsers([fid]);
    return user ?? null;
  } catch (err) {
    console.error('[NeynarUserService] Neynar bulk fetch failed:', (err as Error)?.message ?? err);
    return null;
  }
}

/**
 * Get Neynar user with score caching in KV.
 * Caches the score for 24h to avoid hitting Neynar API on every anon cast.
 * Returns the full NeynarUser (from cache or fresh fetch).
 */
export async function getCachedNeynarUser(env: Env, fid: number): Promise<NeynarUser | null> {
  const cacheKey = `neynar_score:${fid}`;

  try {
    const cached = await env.KV_USER_PROFILES.get(cacheKey, 'json');
    if (cached && typeof cached === 'object' && 'score' in cached) {
      return cached as NeynarUser;
    }
  } catch {
    // KV read failure — fall through to API
  }

  const user = await fetchNeynarUser(env, fid);
  if (user) {
    try {
      await env.KV_USER_PROFILES.put(cacheKey, JSON.stringify(user), {
        expirationTtl: SCORE_CACHE_TTL,
      });
    } catch (err) {
      console.warn('[NeynarUserService] Failed to cache score:', err);
    }
  }

  return user;
}
