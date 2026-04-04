/**
 * FollowService - Manages follow relationships between users
 * 
 * Handles:
 * - Following/unfollowing users
 * - Checking follow status
 * - Getting followers/following lists
 * - Getting follower/following counts
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

export interface FollowRecord {
  follower_fid: number;
  following_fid: number;
  created_at: string;
}

export interface FollowersResult {
  followers: number[];
  total: number;
}

export interface FollowingResult {
  following: number[];
  total: number;
}

export class FollowService {
  private env: Env;

  constructor(env: Env) {
    this.env = env;
  }

  /**
   * Factory method to create service from env
   */
  static fromEnv(env: Env): FollowService {
    return new FollowService(env);
  }

  /**
   * Follow a user
   * 
   * @param followerFid - The FID of the user who is following
   * @param followingFid - The FID of the user being followed
   * @returns true if follow was successful, false if already following
   */
  async follow(followerFid: number, followingFid: number): Promise<boolean> {
    // Prevent self-follow
    if (followerFid === followingFid) {
      return false;
    }

    try {
      const result = await this.env.DB.prepare(`
        INSERT OR IGNORE INTO qbase_follows (follower_fid, following_fid)
        VALUES (?, ?)
      `).bind(followerFid, followingFid).run();

      // INSERT OR IGNORE returns changes: 1 if inserted, 0 if ignored (already exists)
      return result.meta?.changes > 0;
    } catch (error) {
      console.error('[FollowService] Error following user:', error);
      throw error;
    }
  }

  /**
   * Unfollow a user
   * 
   * @param followerFid - The FID of the user who is unfollowing
   * @param followingFid - The FID of the user being unfollowed
   * @returns true if unfollow was successful, false if not following
   */
  async unfollow(followerFid: number, followingFid: number): Promise<boolean> {
    try {
      const result = await this.env.DB.prepare(`
        DELETE FROM qbase_follows
        WHERE follower_fid = ? AND following_fid = ?
      `).bind(followerFid, followingFid).run();

      return result.meta?.changes > 0;
    } catch (error) {
      console.error('[FollowService] Error unfollowing user:', error);
      throw error;
    }
  }

  /**
   * Check if a user is following another user
   * 
   * @param followerFid - The FID of the potential follower
   * @param followingFid - The FID of the user being followed
   * @returns true if following, false otherwise
   */
  async isFollowing(followerFid: number, followingFid: number): Promise<boolean> {
    try {
      const result = await this.env.DB.prepare(`
        SELECT 1 FROM qbase_follows
        WHERE follower_fid = ? AND following_fid = ?
      `).bind(followerFid, followingFid).first();

      return result !== null;
    } catch (error) {
      console.error('[FollowService] Error checking follow status:', error);
      throw error;
    }
  }

  /**
   * Get followers of a user
   * 
   * @param fid - The FID of the user whose followers to get
   * @param limit - Maximum number of results (default: 50)
   * @param offset - Offset for pagination (default: 0)
   * @returns Object with followers array and total count
   */
  async getFollowers(fid: number, limit: number = 50, offset: number = 0): Promise<FollowersResult> {
    try {
      // Get total count
      const countResult = await this.env.DB.prepare(`
        SELECT COUNT(*) as count FROM qbase_follows
        WHERE following_fid = ?
      `).bind(fid).first();

      const total = countResult?.count || 0;

      // Get followers with pagination
      const results = await this.env.DB.prepare(`
        SELECT follower_fid FROM qbase_follows
        WHERE following_fid = ?
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `).bind(fid, limit, offset).all();

      const followers = results.results?.map((row: any) => row.follower_fid) || [];

      return { followers, total };
    } catch (error) {
      console.error('[FollowService] Error getting followers:', error);
      throw error;
    }
  }

  /**
   * Get users that a user is following
   * 
   * @param fid - The FID of the user whose following to get
   * @param limit - Maximum number of results (default: 50)
   * @param offset - Offset for pagination (default: 0)
   * @returns Object with following array and total count
   */
  async getFollowing(fid: number, limit: number = 50, offset: number = 0): Promise<FollowingResult> {
    try {
      // Get total count
      const countResult = await this.env.DB.prepare(`
        SELECT COUNT(*) as count FROM qbase_follows
        WHERE follower_fid = ?
      `).bind(fid).first();

      const total = countResult?.count || 0;

      // Get following with pagination
      const results = await this.env.DB.prepare(`
        SELECT following_fid FROM qbase_follows
        WHERE follower_fid = ?
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `).bind(fid, limit, offset).all();

      const following = results.results?.map((row: any) => row.following_fid) || [];

      return { following, total };
    } catch (error) {
      console.error('[FollowService] Error getting following:', error);
      throw error;
    }
  }

  /**
   * Get the number of followers for a user
   * 
   * @param fid - The FID of the user
   * @returns Number of followers
   */
  async getFollowerCount(fid: number): Promise<number> {
    try {
      const result = await this.env.DB.prepare(`
        SELECT COUNT(*) as count FROM qbase_follows
        WHERE following_fid = ?
      `).bind(fid).first();

      return result?.count || 0;
    } catch (error) {
      console.error('[FollowService] Error getting follower count:', error);
      throw error;
    }
  }

  /**
   * Get the number of users a user is following
   * 
   * @param fid - The FID of the user
   * @returns Number of following
   */
  async getFollowingCount(fid: number): Promise<number> {
    try {
      const result = await this.env.DB.prepare(`
        SELECT COUNT(*) as count FROM qbase_follows
        WHERE follower_fid = ?
      `).bind(fid).first();

      return result?.count || 0;
    } catch (error) {
      console.error('[FollowService] Error getting following count:', error);
      throw error;
    }
  }
}
