/**
 * NeynarUserService — shared Neynar user lookup with KV caching.
 *
 * Extracted from bartlet/airdrop.ts so both the airdrop pipeline
 * and the anon-cast score gate can use it.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

export interface NeynarUser {
  fid: number;
  username?: string;
  display_name?: string;
  score?: number;
  custody_address?: string;
  verified_addresses?: {
    eth_addresses?: string[];
    primary?: { eth_address?: string };
  };
}

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
  const res = await fetch(`https://api.neynar.com/v2/farcaster/user/bulk?fids=${fid}`, {
    headers: {
      'x-api-key': apiKey,
      'x-neynar-experimental': 'true',
    },
  });
  if (!res.ok) {
    console.error('[NeynarUserService] Neynar bulk fetch failed:', res.status);
    return null;
  }
  const data = (await res.json()) as { users?: NeynarUser[] };
  return data.users?.[0] ?? null;
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
