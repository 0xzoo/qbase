/**
 * Neynar helper functions for allowlist social graph checks
 * These functions verify follower/following relationships via Neynar API
 */

export class NeynarAllowlistHelper {
  private static BASE_URL = 'https://api.neynar.com/v2/farcaster';

  /**
   * Import besties (top N users by mutual affinity score)
   * Returns array of FIDs
   */
  static async importBesties(
    fid: number,
    neynarApiKey: string,
    limit: number = 50
  ): Promise<number[]> {
    const response = await fetch(
      `${this.BASE_URL}/user/best_friends?fid=${fid}&limit=${Math.min(limit, 50)}`,
      {
        headers: {
          'x-api-key': neynarApiKey,
        },
      }
    );

    if (!response.ok) {
      throw new Error(`Neynar API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as { users?: { fid: number }[] };
    return data.users?.map((u) => u.fid) || [];
  }

  /**
   * Check if requesterFid follows ownerFid
   * Used for 'my_followers' list type
   */
  static async checkFollowsMe(
    ownerFid: number,
    requesterFid: number,
    neynarApiKey: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    cache?: any // KV cache
  ): Promise<boolean> {
    const cacheKey = `neynar:follows_me:${ownerFid}:${requesterFid}`;

    // Check cache first (10 min TTL)
    if (cache) {
      const cached = await cache.get(cacheKey);
      if (cached !== null) {
        return cached === '1';
      }
    }

    // Use bulk user fetch with viewer_context to check relationship
    const response = await fetch(
      `${this.BASE_URL}/user/bulk?fids=${requesterFid}&viewer_fid=${ownerFid}`,
      {
        headers: {
          'x-api-key': neynarApiKey,
        },
      }
    );

    if (!response.ok) {
      console.error(`Neynar API error: ${response.status}`);
      return false;
    }

    const data = await response.json() as { users?: { viewer_context?: { followed_by: boolean } }[] };
    const follows = data.users?.[0]?.viewer_context?.followed_by || false;

    // Cache result for 10 minutes
    if (cache) {
      await cache.put(cacheKey, follows ? '1' : '0', { expirationTtl: 600 });
    }

    return follows;
  }

  /**
   * Check if ownerFid follows requesterFid
   * Used for 'my_following' list type
   */
  static async checkIFollow(
    ownerFid: number,
    requesterFid: number,
    neynarApiKey: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    cache?: any
  ): Promise<boolean> {
    const cacheKey = `neynar:i_follow:${ownerFid}:${requesterFid}`;

    // Check cache first (10 min TTL)
    if (cache) {
      const cached = await cache.get(cacheKey);
      if (cached !== null) {
        return cached === '1';
      }
    }

    // Use bulk user fetch with viewer_context to check relationship
    const response = await fetch(
      `${this.BASE_URL}/user/bulk?fids=${requesterFid}&viewer_fid=${ownerFid}`,
      {
        headers: {
          'x-api-key': neynarApiKey,
        },
      }
    );

    if (!response.ok) {
      console.error(`Neynar API error: ${response.status}`);
      return false;
    }

    const data = await response.json() as { users?: { viewer_context?: { following: boolean } }[] };
    const follows = data.users?.[0]?.viewer_context?.following || false;

    // Cache result for 10 minutes
    if (cache) {
      await cache.put(cacheKey, follows ? '1' : '0', { expirationTtl: 600 });
    }

    return follows;
  }

  /**
   * Check if ownerFid and requesterFid mutually follow each other
   * Used for 'mutual_followers' list type
   */
  static async checkMutualFollow(
    ownerFid: number,
    requesterFid: number,
    neynarApiKey: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    cache?: any
  ): Promise<boolean> {
    const cacheKey = `neynar:mutual:${ownerFid}:${requesterFid}`;

    // Check cache first (10 min TTL)
    if (cache) {
      const cached = await cache.get(cacheKey);
      if (cached !== null) {
        return cached === '1';
      }
    }

    // Use bulk user fetch with viewer_context to check both directions
    const response = await fetch(
      `${this.BASE_URL}/user/bulk?fids=${requesterFid}&viewer_fid=${ownerFid}`,
      {
        headers: {
          'x-api-key': neynarApiKey,
        },
      }
    );

    if (!response.ok) {
      console.error(`Neynar API error: ${response.status}`);
      return false;
    }

    const data = await response.json() as { users?: { viewer_context?: { following: boolean; followed_by: boolean } }[] };
    const viewerContext = data.users?.[0]?.viewer_context;
    const isMutual = viewerContext?.following && viewerContext?.followed_by;

    // Cache result for 10 minutes
    if (cache) {
      await cache.put(cacheKey, isMutual ? '1' : '0', { expirationTtl: 600 });
    }

    return isMutual || false;
  }

  /**
   * Generic relationship checker that routes to the appropriate function
   */
  static async checkRelationship(
    ownerFid: number,
    requesterFid: number,
    relationType: string,
    neynarApiKey: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    cache?: any
  ): Promise<boolean> {
    switch (relationType) {
      case 'my_followers':
        return this.checkFollowsMe(ownerFid, requesterFid, neynarApiKey, cache);
      case 'my_following':
        return this.checkIFollow(ownerFid, requesterFid, neynarApiKey, cache);
      case 'mutual_followers':
        return this.checkMutualFollow(ownerFid, requesterFid, neynarApiKey, cache);
      default:
        console.error(`Unknown relation type: ${relationType}`);
        return false;
    }
  }
}
