/**
 * Neynar API Service
 * 
 * Service for interacting with the Neynar Farcaster API.
 * Provides methods for fetching user data, casts, and more.
 * 
 * API Documentation: https://docs.neynar.com/reference/quickstart
 * 
 * Note: KVNamespace type is only available in Cloudflare Worker context.
 * For client-side code, KV-dependent methods should be called from worker endpoints.
 */

// ============================================================================
// Type Definitions
// ============================================================================

export interface FCUser {
  fid: string
  username: string
  displayName: string
  pfpUrl: string
  location: {
    placeId: string
    description: string
  }
}

export interface NeynarUser {
  object: 'user'
  fid: string
  username: string
  display_name: string
  custody_address: string
  pfp_url: string
  profile: {
    bio: {
      text: string
      mentioned_profiles?: Array<{
        object: 'user_dehydrated'
        fid: number
        username: string
        display_name: string
        pfp_url: string
        custody_address: string
      }>
      mentioned_profiles_ranges?: Array<{
        start: number
        end: number
      }>
      mentioned_channels?: Array<{
        id: string
        name: string
        object: 'channel_dehydrated'
        image_url: string
        viewer_context: {
          following: boolean
          role: string
        }
      }>
      mentioned_channels_ranges?: Array<{
        start: number
        end: number
      }>
    }
    location?: {
      latitude: number
      longitude: number
      address: {
        city: string
        state: string
        state_code: string
        country: string
        country_code: string
      }
    }
  }
  follower_count: number
  following_count: number
  verifications: string[]
  verified_addresses: {
    eth_addresses: string[]
    sol_addresses: string[]
    primary: {
      eth_address: string
      sol_address: string
    }
  }
  verified_accounts?: Array<{
    platform: string
    username: string
  }>
  power_badge?: boolean
  experimental?: {
    neynar_user_score: number
  }
  viewer_context?: {
    following: boolean
    followed_by: boolean
    blocking: boolean
    blocked_by: boolean
  }
}

export interface NeynarCast {
  author: NeynarUser
  parentUrl: string
  rootParentUrl: string
  parentAuthor: {
    fid: number
  }
  text: string
}

export type NeynarGetUserCastsResponse = {
  casts: NeynarCast[]
  next: {
    cursor: string
  }
}

export type Cast = {
  text: string
  castedAtTimestamp: number
  parentCast?: {
    text: string
    rawText: string
    hash: string
  }
}

export type CastData = {
  FarcasterCasts: {
    Cast: Cast[]
  }
}

// ============================================================================
// Follow API Types
// ============================================================================

export interface UserDehydrated {
  object: 'user_dehydrated'
  fid: number
  username: string
  display_name: string
  pfp_url: string
  custody_address?: string
  score?: number
}

export interface FollowerObject {
  object: 'follower'
  app?: UserDehydrated
  user: NeynarUser
}

export interface FollowersResponse {
  users: FollowerObject[]
  next?: {
    cursor: string
  }
}

export interface FollowerDehydrated {
  object: 'follower_dehydrated'
  user: UserDehydrated
}

export interface RelevantFollowersResponse {
  top_relevant_followers_hydrated: FollowerObject[]
  all_relevant_followers_dehydrated: FollowerDehydrated[]
}

export interface BestFriend {
  fid: number
  mutual_affinity_score: number
  username: string
}

export interface BestFriendsResponse {
  users: BestFriend[]
  next?: {
    cursor: string
  }
}

export interface MuteObject {
  object: 'mute'
  muted: NeynarUser
  muted_at: string
}

export interface MutesResponse {
  mutes: MuteObject[]
  next?: {
    cursor: string
  }
}

export interface BlockObject {
  object: 'block'
  blocked: NeynarUser
  blocker: NeynarUser
  blocked_at: string
}

export interface BlocksResponse {
  blocks: BlockObject[]
  next?: {
    cursor: string
  }
}

export interface MutesAndBlocksResponse {
  mutes: MuteObject[]
  blocks: BlockObject[]
  all_fids: number[]
}

// ============================================================================
// Service Class
// ============================================================================

export class NeynarService {
  private static readonly BASE_URL = 'https://api.neynar.com/v2/farcaster';

  /**
   * Fetches a user by their FID
   * @param fid Farcaster user ID
   * @param neynarApiKey Neynar API key
   * @returns Promise<NeynarUser>
   * @throws Error if fetch fails
   */
  static async fetchUser(fid: string, neynarApiKey: string): Promise<NeynarUser> {
    const response = await fetch(
      `${this.BASE_URL}/user/bulk?fids=${fid}`,
      {
        headers: {
          "x-api-key": neynarApiKey,
          "x-neynar-experimental": "true"
        },
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch Farcaster user on Neynar: ${response.statusText}`);
    }

    const data = await response.json() as { users: NeynarUser[] };
    return data.users[0];
  }

  /**
   * Fetches a user by their username
   * @param username Farcaster username (without @ symbol)
   * @param neynarApiKey Neynar API key
   * @returns Promise<NeynarUser>
   * @throws Error if fetch fails
   */
  static async fetchUserByUsername(username: string, neynarApiKey: string): Promise<NeynarUser> {
    const response = await fetch(
      `${this.BASE_URL}/user/by_username?username=${username}`,
      {
        headers: {
          "x-api-key": neynarApiKey,
          "x-neynar-experimental": "true"
        },
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch Farcaster user on Neynar: ${response.statusText}`);
    }

    const data = await response.json() as { user: NeynarUser };
    return data.user;
  }

  /**
   * Fetches multiple users by their FIDs in a single request
   * @param fids Array of Farcaster user IDs
   * @param neynarApiKey Neynar API key
   * @returns Promise<NeynarUser[]>
   * @throws Error if fetch fails
   */
  static async fetchBulkUsers(fids: string[], neynarApiKey: string): Promise<NeynarUser[]> {
    const fidsParam = fids.join(',');
    const response = await fetch(
      `${this.BASE_URL}/user/bulk?fids=${fidsParam}`,
      {
        headers: {
          "x-api-key": neynarApiKey,
          "x-neynar-experimental": "true"
        },
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch bulk users on Neynar: ${response.statusText}`);
    }

    const data = await response.json() as { users: NeynarUser[] };
    return data.users;
  }

  /**
   * Fetches a user's profile picture with KV caching
   * @param fid Farcaster user ID
   * @param kv KV namespace for caching profile pictures (Cloudflare Workers KV)
   * @param neynarApiKey Neynar API key
   * @param options Optional configuration parameters
   * @returns Promise<string> URL of the profile picture
   */
  static async fetchUserPfp(
    fid: string,
    kv: any, // KVNamespace type available in worker context
    neynarApiKey: string,
    options?: {
      cacheTtl?: number;
      forceRefresh?: boolean;
      defaultAvatarUrl?: string;
    }
  ): Promise<string> {
    const {
      cacheTtl = 86400, // 24 hours default
      forceRefresh = false,
      defaultAvatarUrl = "https://default-avatar-url.com/placeholder.png"
    } = options || {};

    const cacheKey = `user_pfp:${fid}`;

    try {
      // Skip cache if forceRefresh is true
      if (!forceRefresh) {
        const cachedPfp = await kv.get(cacheKey);
        if (cachedPfp) {
          console.log('cachedPfp found', cachedPfp);
          return cachedPfp;
        }
      }

      // If not in cache or force refresh, fetch from Neynar
      const user = await this.fetchUser(fid, neynarApiKey);
      const pfpUrl = user.pfp_url || defaultAvatarUrl;

      // Cache the result
      await kv.put(cacheKey, pfpUrl, { expirationTtl: cacheTtl });

      return pfpUrl;
    } catch (error) {
      console.error(`Error fetching profile picture for FID ${fid}:`, error);

      // Try to get from cache even if forceRefresh was true
      if (forceRefresh) {
        const cachedPfp = await kv.get(cacheKey);
        if (cachedPfp) {
          return cachedPfp;
        }
      }

      // Return default avatar as last resort
      return defaultAvatarUrl;
    }
  }

  /**
   * Fetches a user's casts (posts)
   * @param fid Farcaster user ID
   * @param limit Number of casts to return (max 100)
   * @param cursor Pagination cursor for fetching next page
   * @param includeReplies Whether to include reply casts
   * @param neynarApiKey Neynar API key
   * @returns Promise<Response>
   */
  static async fetchUserCasts(
    fid: string,
    limit: string,
    cursor: string | null,
    includeReplies: boolean,
    neynarApiKey: string
  ): Promise<Response> {
    let url = `${this.BASE_URL}/feed/user/casts?fid=${fid}&limit=${limit}&include_replies=${includeReplies}`;

    if (cursor) {
      url += `&cursor=${cursor}`;
    }

    return fetch(url, {
      method: 'GET',
      headers: {
        'accept': 'application/json',
        'x-api-key': neynarApiKey,
      }
    });
  }

  /**
   * Search for users matching a query
   * @param query Search query string
   * @param neynarApiKey Neynar API key
   * @param limit Number of results to return (default 10, max 100)
   * @param cursor Pagination cursor
   * @returns Promise containing users array and pagination cursor
   */
  static async searchUsers(
    query: string,
    neynarApiKey: string,
    limit: number = 10,
    cursor?: string
  ): Promise<{ users: NeynarUser[], next?: { cursor: string } }> {
    let url = `${this.BASE_URL}/user/search?q=${encodeURIComponent(query)}&limit=${limit}`;

    if (cursor) {
      url += `&cursor=${cursor}`;
    }

    const response = await fetch(url, {
      headers: {
        "x-api-key": neynarApiKey,
        "x-neynar-experimental": "true"
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to search users on Neynar: ${response.statusText}`);
    }

    const data = await response.json() as { result: { users: NeynarUser[], next?: { cursor: string } } };
    return data.result;
  }

  /**
   * Get followers for a specific user
   * @param fid Farcaster user ID whose followers to fetch
   * @param neynarApiKey Neynar API key
   * @param limit Number of results to fetch (default 25, max 100)
   * @param cursor Pagination cursor
   * @param viewerFid Optional FID of the viewer for context (includes viewer_context and respects mutes/blocks)
   * @param sortType Sort type: 'desc_chron' (default) or 'algorithmic'
   * @returns Promise<FollowersResponse>
   * @throws Error if fetch fails
   */
  static async getFollowers(
    fid: string,
    neynarApiKey: string,
    limit: number = 25,
    cursor?: string,
    viewerFid?: string,
    sortType: 'desc_chron' | 'algorithmic' = 'desc_chron'
  ): Promise<FollowersResponse> {
    let url = `${this.BASE_URL}/followers?fid=${fid}&limit=${limit}&sort_type=${sortType}`;

    if (cursor) {
      url += `&cursor=${cursor}`;
    }

    if (viewerFid) {
      url += `&viewer_fid=${viewerFid}`;
    }

    const response = await fetch(url, {
      headers: {
        "x-api-key": neynarApiKey,
        "x-neynar-experimental": "true"
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch followers on Neynar: ${response.statusText}`);
    }

    return await response.json() as FollowersResponse;
  }

  /**
   * Get users that a specific user is following
   * @param fid Farcaster user ID whose following list to fetch
   * @param neynarApiKey Neynar API key
   * @param limit Number of results to fetch (default 25, max 100)
   * @param cursor Pagination cursor
   * @param viewerFid Optional FID of the viewer for context (includes viewer_context and respects mutes/blocks)
   * @param sortType Sort type: 'desc_chron' (default) or 'algorithmic'
   * @returns Promise<FollowersResponse>
   * @throws Error if fetch fails
   */
  static async getFollowing(
    fid: string,
    neynarApiKey: string,
    limit: number = 25,
    cursor?: string,
    viewerFid?: string,
    sortType: 'desc_chron' | 'algorithmic' = 'desc_chron'
  ): Promise<FollowersResponse> {
    let url = `${this.BASE_URL}/following?fid=${fid}&limit=${limit}&sort_type=${sortType}`;

    if (cursor) {
      url += `&cursor=${cursor}`;
    }

    if (viewerFid) {
      url += `&viewer_fid=${viewerFid}`;
    }

    const response = await fetch(url, {
      headers: {
        "x-api-key": neynarApiKey,
        "x-neynar-experimental": "true"
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch following on Neynar: ${response.statusText}`);
    }

    return await response.json() as FollowersResponse;
  }

  /**
   * Get relevant followers (mutual connections) between target and viewer
   * Returns followers of target_fid that viewer_fid also follows
   * Useful for displaying "X, Y, and Z follow this user" on profiles
   * @param targetFid FID of the user whose relevant followers to fetch
   * @param viewerFid FID of the viewer looking at the target user
   * @param neynarApiKey Neynar API key
   * @returns Promise<RelevantFollowersResponse>
   * @throws Error if fetch fails
   */
  static async getMutuals(
    targetFid: string,
    viewerFid: string,
    neynarApiKey: string
  ): Promise<RelevantFollowersResponse> {
    const url = `${this.BASE_URL}/followers/relevant?target_fid=${targetFid}&viewer_fid=${viewerFid}`;

    const response = await fetch(url, {
      headers: {
        "x-api-key": neynarApiKey,
        "x-neynar-experimental": "true"
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch mutual followers on Neynar: ${response.statusText}`);
    }

    return await response.json() as RelevantFollowersResponse;
  }

  /**
   * Get best friends for a user ranked by mutual affinity score
   * Affinity is based on interaction frequency and strength
   * @param fid Farcaster user ID whose best friends to fetch
   * @param neynarApiKey Neynar API key
   * @param limit Number of results to fetch (default 5, max 100)
   * @param cursor Pagination cursor
   * @returns Promise<BestFriendsResponse>
   * @throws Error if fetch fails
   */
  static async getBesties(
    fid: string,
    neynarApiKey: string,
    limit: number = 5,
    cursor?: string
  ): Promise<BestFriendsResponse> {
    let url = `${this.BASE_URL}/user/best_friends?fid=${fid}&limit=${limit}`;

    if (cursor) {
      url += `&cursor=${cursor}`;
    }

    const response = await fetch(url, {
      headers: {
        "x-api-key": neynarApiKey
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch best friends on Neynar: ${response.statusText}`);
    }

    return await response.json() as BestFriendsResponse;
  }

  /**
   * Get list of FIDs that a user has muted
   * Note: Mutes are private and only accessible to the user who created them
   * @param fid Farcaster user ID whose mute list to fetch
   * @param neynarApiKey Neynar API key
   * @param limit Number of results to fetch (default 20, max 100)
   * @param cursor Pagination cursor
   * @returns Promise<MutesResponse>
   * @throws Error if fetch fails
   */
  static async getMutes(
    fid: string,
    neynarApiKey: string,
    limit: number = 20,
    cursor?: string
  ): Promise<MutesResponse> {
    let url = `${this.BASE_URL}/mute/list?fid=${fid}&limit=${limit}`;

    if (cursor) {
      url += `&cursor=${cursor}`;
    }

    const response = await fetch(url, {
      headers: {
        "x-api-key": neynarApiKey,
        "x-neynar-experimental": "true"
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch mutes on Neynar: ${response.statusText}`);
    }

    return await response.json() as MutesResponse;
  }

  /**
   * Get list of FIDs that a user has blocked or has been blocked by
   * @param blockerFid Optional FID to get users that this user has blocked
   * @param blockedFid Optional FID to get users that have blocked this user
   * @param neynarApiKey Neynar API key
   * @param limit Number of results to fetch (default 20, max 100)
   * @param cursor Pagination cursor
   * @returns Promise<BlocksResponse>
   * @throws Error if fetch fails or if neither blockerFid nor blockedFid is provided
   */
  static async getBlocks(
    neynarApiKey: string,
    options: {
      blockerFid?: string;
      blockedFid?: string;
      limit?: number;
      cursor?: string;
    }
  ): Promise<BlocksResponse> {
    const { blockerFid, blockedFid, limit = 20, cursor } = options;

    if (!blockerFid && !blockedFid) {
      throw new Error('Either blockerFid or blockedFid must be provided');
    }

    let url = `${this.BASE_URL}/block/list?limit=${limit}`;

    if (blockerFid) {
      url += `&blocker_fid=${blockerFid}`;
    }

    if (blockedFid) {
      url += `&blocked_fid=${blockedFid}`;
    }

    if (cursor) {
      url += `&cursor=${cursor}`;
    }

    const response = await fetch(url, {
      headers: {
        "x-api-key": neynarApiKey,
        "x-neynar-experimental": "true"
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch blocks on Neynar: ${response.statusText}`);
    }

    return await response.json() as BlocksResponse;
  }

  /**
   * Get combined list of all users that a user has muted or blocked
   * This is a convenience method that calls both getMutes and getBlocks
   * and returns a unified response with all FIDs
   * @param fid Farcaster user ID whose mute and block lists to fetch
   * @param neynarApiKey Neynar API key
   * @param limit Number of results to fetch per endpoint (default 100)
   * @returns Promise<MutesAndBlocksResponse>
   * @throws Error if either fetch fails
   */
  static async getMutesAndBlocks(
    fid: string,
    neynarApiKey: string,
    limit: number = 100
  ): Promise<MutesAndBlocksResponse> {
    // Fetch both mutes and blocks in parallel
    const [mutesResponse, blocksResponse] = await Promise.all([
      this.getMutes(fid, neynarApiKey, limit),
      this.getBlocks(neynarApiKey, { blockerFid: fid, limit })
    ]);

    // Extract all unique FIDs from both lists
    const mutedFids = mutesResponse.mutes.map(m => m.muted.fid);
    const blockedFids = blocksResponse.blocks.map(b => b.blocked.fid);

    // Combine and deduplicate FIDs
    const allFidsSet = new Set([
      ...mutedFids.map(fid => parseInt(String(fid))),
      ...blockedFids.map(fid => parseInt(String(fid)))
    ]);
    const allFids = Array.from(allFidsSet).sort((a, b) => a - b);

    return {
      mutes: mutesResponse.mutes,
      blocks: blocksResponse.blocks,
      all_fids: allFids
    };
  }
}

// ============================================================================
// Legacy Function Exports (for backward compatibility)
// ============================================================================

/**
 * @deprecated Use NeynarService.fetchUser instead
 */
export const fetchUser = NeynarService.fetchUser.bind(NeynarService);

/**
 * @deprecated Use NeynarService.fetchUserByUsername instead
 */
export const fetchUserByUsername = NeynarService.fetchUserByUsername.bind(NeynarService);

/**
 * @deprecated Use NeynarService.fetchUserPfp instead
 */
export const fetchUserPfp = NeynarService.fetchUserPfp.bind(NeynarService);

/**
 * @deprecated Use NeynarService.fetchUserCasts instead
 */
export async function fetchUserCasts(
  fid: string,
  limit: string,
  cursor: string | null,
  includeReplies: boolean,
  neynarApiKey: string
): Promise<Response> {
  return NeynarService.fetchUserCasts(fid, limit, cursor, includeReplies, neynarApiKey);
}
