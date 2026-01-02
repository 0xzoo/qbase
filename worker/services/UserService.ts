/**
 * User Service
 * 
 * Manages user records in the database.
 * Internal user IDs provide identity abstraction - FID is just one auth method.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

export interface CreateUserParams {
  fid: number;
  fname: string;
  displayName?: string;
  pfpUrl?: string;
  primaryAddress?: string;
}

export interface User {
  id: number;
  fid: number;
  fname: string;
  created_at: number;
  primary_address: string | null;
  q_cost: number;
  socials: string | null;
}

export class UserService {
  /**
   * Create or update a user record (upsert)
   * Safe to call multiple times - will update existing user if FID exists
   * 
   * @param env - Cloudflare environment
   * @param params - User creation parameters
   * @returns User record with internal ID
   */
  static async upsert(env: Env, params: CreateUserParams): Promise<User> {
    const now = Date.now();
    
    const DEFAULT_Q_COST = 3;

    try {
      // Check if user already exists
      const existing = await env.DB.prepare(`
        SELECT * FROM users WHERE fid = ?
      `).bind(params.fid).first();

      if (existing) {
        // User exists - update their profile data
        await env.DB.prepare(`
          UPDATE users 
          SET fname = ?,
              primary_address = COALESCE(?, primary_address)
          WHERE fid = ?
        `).bind(
          params.fname,
          params.primaryAddress || null,
          params.fid
        ).run();

        // Return updated user
        const updated = await env.DB.prepare(`
          SELECT * FROM users WHERE fid = ?
        `).bind(params.fid).first();

        return this.parseUser(updated);
      }

      // User doesn't exist - create new record
      // Note: Points are managed separately in KV_USER_POINTS via PointsService
      const result = await env.DB.prepare(`
        INSERT INTO users (
          fname, 
          fid, 
          created_at, 
          primary_address, 
          q_cost,
          socials
        ) VALUES (?, ?, ?, ?, ?, ?)
        RETURNING *
      `).bind(
        params.fname,
        params.fid,
        now,
        params.primaryAddress || null,
        DEFAULT_Q_COST,
        null
      ).first();

      if (!result) {
        throw new Error('Failed to create user');
      }

      console.log(`✅ Created new user: ${params.fname} (FID: ${params.fid}, ID: ${result.id})`);

      return this.parseUser(result);
    } catch (error) {
      console.error('Error upserting user:', error);
      throw error;
    }
  }

  /**
   * Get user by FID
   */
  static async getByFid(env: Env, fid: number): Promise<User | null> {
    try {
      const result = await env.DB.prepare(`
        SELECT * FROM users WHERE fid = ?
      `).bind(fid).first();

      if (!result) {
        return null;
      }

      return this.parseUser(result);
    } catch (error) {
      console.error('Error getting user by FID:', error);
      return null;
    }
  }

  /**
   * Get user by internal ID
   */
  static async getById(env: Env, id: number): Promise<User | null> {
    try {
      const result = await env.DB.prepare(`
        SELECT * FROM users WHERE id = ?
      `).bind(id).first();

      if (!result) {
        return null;
      }

      return this.parseUser(result);
    } catch (error) {
      console.error('Error getting user by ID:', error);
      return null;
    }
  }

  /**
   * Parse database row into User object
   */
  private static parseUser(row: any): User {
    return {
      id: row.id,
      fid: row.fid,
      fname: row.fname,
      created_at: row.created_at,
      primary_address: row.primary_address || null,
      q_cost: row.q_cost || 3,
      socials: row.socials || null,
    };
  }
}

