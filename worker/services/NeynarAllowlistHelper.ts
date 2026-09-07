/**
 * Neynar helper functions for allowlist social graph checks.
 *
 * Follower / following / besties relationships. Neynar-pinned on purpose:
 * the viewer_context and best_friends endpoints are Neynar computations. When
 * the own hub is live, `linksByFid` can back these (Track C3 graph trust).
 */

import { NeynarDataProvider } from './farcaster/NeynarDataProvider';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type KVLike = any;

export class NeynarAllowlistHelper {
  /**
   * Import besties (top N users by mutual affinity score)
   * Returns array of FIDs
   */
  static async importBesties(
    fid: number,
    neynarApiKey: string,
    limit: number = 50
  ): Promise<number[]> {
    return new NeynarDataProvider({ apiKey: neynarApiKey }).getBestFriends(fid, limit);
  }

  /** Relationship of `requesterFid` as seen by `ownerFid`, or null when Neynar has no answer. */
  private static async viewerContext(
    ownerFid: number,
    requesterFid: number,
    neynarApiKey: string,
  ): Promise<{ following: boolean; followed_by: boolean } | null> {
    try {
      const [user] = await new NeynarDataProvider({ apiKey: neynarApiKey })
        .getUsers([requesterFid], { viewerFid: ownerFid });
      return user?.viewer_context ?? null;
    } catch (err) {
      console.error(`Neynar API error: ${(err as Error)?.message ?? err}`);
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

  /**
   * Check if requesterFid follows ownerFid
   * Used for 'my_followers' list type
   */
  static async checkFollowsMe(
    ownerFid: number,
    requesterFid: number,
    neynarApiKey: string,
    cache?: KVLike
  ): Promise<boolean> {
    return this.cached(cache, `neynar:follows_me:${ownerFid}:${requesterFid}`, async () => {
      const ctx = await this.viewerContext(ownerFid, requesterFid, neynarApiKey);
      return ctx?.followed_by || false;
    });
  }

  /**
   * Check if ownerFid follows requesterFid
   * Used for 'my_following' list type
   */
  static async checkIFollow(
    ownerFid: number,
    requesterFid: number,
    neynarApiKey: string,
    cache?: KVLike
  ): Promise<boolean> {
    return this.cached(cache, `neynar:i_follow:${ownerFid}:${requesterFid}`, async () => {
      const ctx = await this.viewerContext(ownerFid, requesterFid, neynarApiKey);
      return ctx?.following || false;
    });
  }

  /**
   * Check if ownerFid and requesterFid mutually follow each other
   * Used for 'mutual_followers' list type
   */
  static async checkMutualFollow(
    ownerFid: number,
    requesterFid: number,
    neynarApiKey: string,
    cache?: KVLike
  ): Promise<boolean> {
    return this.cached(cache, `neynar:mutual:${ownerFid}:${requesterFid}`, async () => {
      const ctx = await this.viewerContext(ownerFid, requesterFid, neynarApiKey);
      return Boolean(ctx?.following && ctx?.followed_by);
    });
  }

  /**
   * Generic relationship checker that routes to the appropriate function
   */
  static async checkRelationship(
    ownerFid: number,
    requesterFid: number,
    relationType: string,
    neynarApiKey: string,
    cache?: KVLike
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
