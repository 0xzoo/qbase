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
  proStatus?: 'subscribed' | 'unsubscribed';
  proExpiresAt?: string;
}

export interface User {
  id: number;
  fid: number | null;
  quil_address: string | null;
  fname: string;
  created_at: number;
  primary_address: string | null;
  q_cost: number;
  socials: string | null;
  pro_status: 'subscribed' | 'unsubscribed' | null;
  pro_expires_at: string | null;
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
        // User exists - update their profile data (including pro status on each login)
        await env.DB.prepare(`
          UPDATE users 
          SET fname = ?,
              primary_address = COALESCE(?, primary_address),
              pro_status = COALESCE(?, pro_status),
              pro_expires_at = COALESCE(?, pro_expires_at)
          WHERE fid = ?
        `).bind(
          params.fname,
          params.primaryAddress || null,
          params.proStatus || null,
          params.proExpiresAt || null,
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
          socials,
          pro_status,
          pro_expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING *
      `).bind(
        params.fname,
        params.fid,
        now,
        params.primaryAddress || null,
        DEFAULT_Q_COST,
        null,
        params.proStatus || null,
        params.proExpiresAt || null
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
   * Get user by quil_address (passkey identity)
   */
  static async getByQuilAddress(env: Env, quilAddress: string): Promise<User | null> {
    try {
      const result = await env.DB.prepare(`
        SELECT * FROM users WHERE quil_address = ?
      `).bind(quilAddress).first();

      if (!result) {
        return null;
      }

      return this.parseUser(result);
    } catch (error) {
      console.error('Error getting user by quil_address:', error);
      return null;
    }
  }

  /**
   * Get user by either quil_address or fid
   */
  static async getByIdentity(env: Env, { quilAddress, fid }: { quilAddress?: string; fid?: number }): Promise<User | null> {
    if (quilAddress) {
      return this.getByQuilAddress(env, quilAddress);
    }
    if (fid) {
      return this.getByFid(env, fid);
    }
    return null;
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
      fid: row.fid || null,
      quil_address: row.quil_address || null,
      fname: row.fname,
      created_at: row.created_at,
      primary_address: row.primary_address || null,
      q_cost: row.q_cost || 3,
      socials: row.socials || null,
      pro_status: row.pro_status || null,
      pro_expires_at: row.pro_expires_at || null,
    };
  }
}

