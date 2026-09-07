/**
 * Social-graph helpers for allowlists: besties, follower / following /
 * mutual checks. Every read goes through the Farcaster data router (Haatz
 * first, Neynar as fallback — Track C card C10); nothing here is pinned to
 * Neynar any more.
 *
 * Besties: Haatz ranks `user/best_friends` by mutual-follow recency, Neynar by
 * affinity. Recency is accepted (plan C10); an in-house ranking from
 * `linksByFid` + the reply graph can replace it once the own node is up (C3).
 */

import { initFarcasterData, type FarcasterDataRouter } from './farcaster';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type KVLike = any;

export class AllowlistGraphHelper {
  /** Top N mutual-follow accounts for a FID, as the first capable provider ranks them. */
  static async importBesties(env: Env, fid: number, limit: number = 50, router?: FarcasterDataRouter): Promise<number[]> {
    return (router ?? initFarcasterData(env)).getBestFriends(fid, limit);
  }

  /** Relationship of `requesterFid` as seen by `ownerFid`, or null when no provider can answer. */
  private static async relationship(
    env: Env,
    ownerFid: number,
    requesterFid: number,
    router?: FarcasterDataRouter,
  ): Promise<{ following: boolean; followed_by: boolean } | null> {
    try {
      return await (router ?? initFarcasterData(env)).getRelationship(ownerFid, requesterFid);
    } catch (err) {
      console.error(`[AllowlistGraph] relationship lookup failed: ${(err as Error)?.message ?? err}`);
      return null;
    }
  }

  private static async cached(
    cache: KVLike | undefined,
    key: string,
    compute: () => Promise<boolean>,
  ): Promise<boolean> {
    if (cache) {
      const hit = await cache.get(key);
      if (hit !== null) return hit === '1';
    }
    const value = await compute();
    if (cache) {
      await cache.put(key, value ? '1' : '0', { expirationTtl: 600 });
    }
    return value;
  }

  /** Does requesterFid follow ownerFid? ('my_followers') */
  static async checkFollowsMe(env: Env, ownerFid: number, requesterFid: number, cache?: KVLike, router?: FarcasterDataRouter): Promise<boolean> {
    return this.cached(cache, `graph:follows_me:${ownerFid}:${requesterFid}`, async () => {
      const ctx = await this.relationship(env, ownerFid, requesterFid, router);
      return ctx?.followed_by || false;
    });
  }

  /** Does ownerFid follow requesterFid? ('my_following') */
  static async checkIFollow(env: Env, ownerFid: number, requesterFid: number, cache?: KVLike, router?: FarcasterDataRouter): Promise<boolean> {
    return this.cached(cache, `graph:i_follow:${ownerFid}:${requesterFid}`, async () => {
      const ctx = await this.relationship(env, ownerFid, requesterFid, router);
      return ctx?.following || false;
    });
  }

  /** Mutual follow? ('mutual_followers') */
  static async checkMutualFollow(env: Env, ownerFid: number, requesterFid: number, cache?: KVLike, router?: FarcasterDataRouter): Promise<boolean> {
    return this.cached(cache, `graph:mutual:${ownerFid}:${requesterFid}`, async () => {
      const ctx = await this.relationship(env, ownerFid, requesterFid, router);
      return Boolean(ctx?.following && ctx?.followed_by);
    });
  }

  /** Routes a list type to the matching check. */
  static async checkRelationship(env: Env, ownerFid: number, requesterFid: number, relationType: string, cache?: KVLike, router?: FarcasterDataRouter): Promise<boolean> {
    switch (relationType) {
      case 'my_followers':
        return this.checkFollowsMe(env, ownerFid, requesterFid, cache, router);
      case 'my_following':
        return this.checkIFollow(env, ownerFid, requesterFid, cache, router);
      case 'mutual_followers':
        return this.checkMutualFollow(env, ownerFid, requesterFid, cache, router);
      default:
        console.error(`Unknown relation type: ${relationType}`);
        return false;
    }
  }
}
