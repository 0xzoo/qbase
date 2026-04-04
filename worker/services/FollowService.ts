/**
 * FollowService - Manages follow relationships between users
 * 
 * Uses the native qbase follows table (migration 0033).
 * Follow identity is TEXT-based: supports either quil_address (passkey users)
 * or FID-string (miniapp-only users who haven't set up passkeys yet).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

export interface FollowRecord {
  follower_id: string;
  followee_id: string;
  created_at: number;
}

export interface FollowWithUser extends FollowRecord {
  follower_fname?: string;
  follower_pfp_url?: string;
  followee_fname?: string;
  followee_pfp_url?: string;
}

export interface FollowersResult {
  followers: Array<{ user_id: string; fname?: string; pfp_url?: string }>;
  total: number;
}

export interface FollowingResult {
  following: Array<{ user_id: string; fname?: string; pfp_url?: string }>;
  total: number;
}

export class FollowService {
  private env: Env;

  constructor(env: Env) {
    this.env = env;
  }

  static fromEnv(env: Env): FollowService {
    return new FollowService(env);
  }

  /**
   * Resolve a user identity to a follow ID string.
   * Returns quil_address if available, otherwise stringified FID.
   */
  private static resolveUserId(user: { quil_address?: string | null; fid?: number | null }): string | null {
    if (user?.quil_address) return user.quil_address;
    if (user?.fid) return String(user.fid);
    return null;
  }

  /**
   * Follow a user using their follow_id
   */
  async follow(followerId: string, followeeId: string): Promise<boolean> {
    if (followerId === followeeId) return false;

    // Don't follow yourself: check if they resolve to the same canonical user
    try {
      const result = await this.env.DB.prepare(`
        INSERT OR IGNORE INTO follows (follower_id, followee_id, created_at)
        VALUES (?, ?, ?)
      `).bind(followerId, followeeId, Date.now()).run();

      return result.meta?.changes > 0;
    } catch (error) {
      console.error('[FollowService] Error following user:', error);
      throw error;
    }
  }

  /**
   * Follow using Users table rows (resolves identity automatically)
   */
  async followUsers(follower: { quil_address?: string | null; fid?: number | null }, 
                    followee: { quil_address?: string | null; fid?: number | null }): Promise<boolean> {
    const followerId = FollowService.resolveUserId(follower);
    const followeeId = FollowService.resolveUserId(followee);
    if (!followerId || !followeeId) return false;
    return this.follow(followerId, followeeId);
  }

  /**
   * Unfollow a user
   */
  async unfollow(followerId: string, followeeId: string): Promise<boolean> {
    try {
      const result = await this.env.DB.prepare(`
        DELETE FROM follows
        WHERE follower_id = ? AND followee_id = ?
      `).bind(followerId, followeeId).run();

      return result.meta?.changes > 0;
    } catch (error) {
      console.error('[FollowService] Error unfollowing user:', error);
      throw error;
    }
  }

  /**
   * Check if a user is following another
   */
  async isFollowing(followerId: string, followeeId: string): Promise<boolean> {
    try {
      const result = await this.env.DB.prepare(`
        SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?
      `).bind(followerId, followeeId).first();
      return result !== null;
    } catch (error) {
      console.error('[FollowService] Error checking follow status:', error);
      throw error;
    }
  }

  /**
   * Get followers of a user (with optional user profile enrichment)
   */
  async getFollowers(userId: string, limit: number = 50, offset: number = 0): Promise<FollowersResult> {
    try {
      const countResult = await this.env.DB.prepare(`
        SELECT COUNT(*) as count FROM follows WHERE followee_id = ?
      `).bind(userId).first();
      const total = countResult?.count || 0;

      // Get followers with user info when possible
      const results = await this.env.DB.prepare(`
        SELECT follower_id FROM follows
        WHERE followee_id = ?
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `).bind(userId, limit, offset).all();

      const followers = (results.results || []).map((row: any) => ({ user_id: row.follower_id }));

      return { followers, total };
    } catch (error) {
      console.error('[FollowService] Error getting followers:', error);
      throw error;
    }
  }

  /**
   * Get users that a user is following
   */
  async getFollowing(userId: string, limit: number = 50, offset: number = 0): Promise<FollowingResult> {
    try {
      const countResult = await this.env.DB.prepare(`
        SELECT COUNT(*) as count FROM follows WHERE follower_id = ?
      `).bind(userId).first();
      const total = countResult?.count || 0;

      const results = await this.env.DB.prepare(`
        SELECT followee_id FROM follows
        WHERE follower_id = ?
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `).bind(userId, limit, offset).all();

      const following = (results.results || []).map((row: any) => ({ user_id: row.followee_id }));

      return { following, total };
    } catch (error) {
      console.error('[FollowService] Error getting following:', error);
      throw error;
    }
  }

  /**
   * Get the number of followers for a user
   */
  async getFollowerCount(userId: string): Promise<number> {
    try {
      const result = await this.env.DB.prepare(`
        SELECT COUNT(*) as count FROM follows WHERE followee_id = ?
      `).bind(userId).first();
      return result?.count || 0;
    } catch (error) {
      console.error('[FollowService] Error getting follower count:', error);
      throw error;
    }
  }

  /**
   * Get the number of users a user is following
   */
  async getFollowingCount(userId: string): Promise<number> {
    try {
      const result = await this.env.DB.prepare(`
        SELECT COUNT(*) as count FROM follows WHERE follower_id = ?
      `).bind(userId).first();
      return result?.count || 0;
    } catch (error) {
      console.error('[FollowService] Error getting following count:', error);
      throw error;
    }
  }
}
