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
  id: number;       // alias for fid (fid is now the PK)
  fid: number | null;
  quil_address: string | null;
  fname: string;
  username: string | null;
  display_name: string | null;
  pfp_url: string | null;
  bio: string | null;
  profile_source: string | null;
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
   */
  static async upsert(env: Env, params: CreateUserParams): Promise<User> {
    const now = Date.now();
    const DEFAULT_Q_COST = 3;

    try {
      // Check if user already exists
      const existing = await env.DB.prepare(
        'SELECT * FROM users WHERE fid = ?'
      ).bind(params.fid).first();

      if (existing) {
        // pfp_url always tracks the live Farcaster value — the native-pfp
        // tier is gone (every user has a Farcaster identity, brought or
        // assigned). display_name still respects the per-row
        // profile_source: 'native' rows preserve the user's qbase
        // override; everything else takes the incoming Farcaster value.
        const preserveDisplayName = existing.profile_source === 'native';
        const sql = preserveDisplayName
          ? `UPDATE users
             SET fname = ?,
                 display_name = COALESCE(display_name, ?),
                 pfp_url = COALESCE(?, pfp_url),
                 primary_address = COALESCE(?, primary_address),
                 pro_status = COALESCE(?, pro_status),
                 pro_expires_at = COALESCE(?, pro_expires_at)
             WHERE fid = ?`
          : `UPDATE users
             SET fname = ?,
                 display_name = COALESCE(?, display_name),
                 pfp_url = COALESCE(?, pfp_url),
                 primary_address = COALESCE(?, primary_address),
                 pro_status = COALESCE(?, pro_status),
                 pro_expires_at = COALESCE(?, pro_expires_at)
             WHERE fid = ?`;
        await env.DB.prepare(sql).bind(
          params.fname,
          params.displayName || null,
          params.pfpUrl || null,
          params.primaryAddress || null,
          params.proStatus || null,
          params.proExpiresAt || null,
          params.fid
        ).run();

        // Return updated user
        const updated = await env.DB.prepare(
          'SELECT * FROM users WHERE fid = ?'
        ).bind(params.fid).first();

        return this.parseUser(updated);
      }

      // User doesn't exist - create new record
      await env.DB.prepare(`
        INSERT INTO users (
          fname, fid, created_at, primary_address, q_cost, socials,
          pro_status, pro_expires_at, username, display_name, pfp_url, profile_source
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        params.fname,
        params.fid,
        now,
        params.primaryAddress || null,
        DEFAULT_Q_COST,
        null,
        params.proStatus || null,
        params.proExpiresAt || null,
        params.fname,  // seed username from fname
        params.displayName || null,
        params.pfpUrl || null,
        'farcaster'
      ).run();

      // D1 .run() doesn't return rows, need to fetch
      const newUser = await env.DB.prepare(
        'SELECT * FROM users WHERE fid = ?'
      ).bind(params.fid).first();

      if (!newUser) {
        throw new Error('Failed to create user');
      }

      console.log(`[USERS] Created new user: ${params.fname} (FID: ${params.fid}, ID: ${newUser.id})`);
      return this.parseUser(newUser);
    } catch (error) {
      console.error('[USERS] Error upserting user:', error);
      throw error;
    }
  }

  /**
   * Get user by FID
   */
  static async getByFid(env: Env, fid: number): Promise<User | null> {
    try {
      const result = await env.DB.prepare(
        'SELECT * FROM users WHERE fid = ?'
      ).bind(fid).first();
      return result ? this.parseUser(result) : null;
    } catch (error) {
      console.error('[USERS] Error getting user by FID:', error);
      return null;
    }
  }

  /**
   * Get user by quil_address (passkey identity)
   */
  static async getByQuilAddress(env: Env, quilAddress: string): Promise<User | null> {
    try {
      const result = await env.DB.prepare(
        'SELECT * FROM users WHERE quil_address = ?'
      ).bind(quilAddress).first();
      return result ? this.parseUser(result) : null;
    } catch (error) {
      console.error('[USERS] Error getting user by quil_address:', error);
      return null;
    }
  }

  /**
   * Get user by either quil_address or fid
   */
  static async getByIdentity(env: Env, { quilAddress, fid }: { quilAddress?: string; fid?: number }): Promise<User | null> {
    if (quilAddress) return this.getByQuilAddress(env, quilAddress);
    if (fid) return this.getByFid(env, fid);
    return null;
  }

  /**
   * Get user by internal ID
   */
  static async getById(env: Env, id: number): Promise<User | null> {
    try {
      const result = await env.DB.prepare(
        'SELECT * FROM users WHERE fid = ?'
      ).bind(id).first();
      return result ? this.parseUser(result) : null;
    } catch (error) {
      console.error('[USERS] Error getting user by ID:', error);
      return null;
    }
  }

  /**
   * Get user by username
   */
  static async getByUsername(env: Env, username: string): Promise<User | null> {
    const row = await env.DB.prepare(
      'SELECT * FROM users WHERE username = ?'
    ).bind(username).first();
    return row ? this.parseUser(row) : null;
  }

  /**
   * Update native profile fields (username, display_name, bio).
   * pfp_url is intentionally not editable here — the avatar tracks the
   * user's Farcaster identity and is refreshed on every login via
   * upsert(). Only updates fields that are explicitly provided.
   */
  static async updateProfile(
    env: Env,
    userId: number,
    updates: { username?: string; display_name?: string; bio?: string }
  ): Promise<User | null> {
    const setClauses: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const values: any[] = [];

    if (updates.username !== undefined) {
      setClauses.push('username = ?');
      values.push(updates.username);
    }
    if (updates.display_name !== undefined) {
      setClauses.push('display_name = ?');
      values.push(updates.display_name);
    }
    if (updates.bio !== undefined) {
      setClauses.push('bio = ?');
      values.push(updates.bio);
    }

    if (setClauses.length === 0) return this.getById(env, userId);

    // Mark as native profile once user edits anything
    setClauses.push("profile_source = 'native'");

    values.push(userId);
    await env.DB.prepare(
      `UPDATE users SET ${setClauses.join(', ')} WHERE fid = ?`
    ).bind(...values).run();

    return this.getById(env, userId);
  }

  /**
   * Parse database row into User object
   */
   
  static parseUser(row: any): User {  // eslint-disable-line @typescript-eslint/no-explicit-any
    return {
      id: row.fid,     // fid IS the PK — no separate id column
      fid: row.fid,
      quil_address: row.quil_address || null,
      fname: row.fname,
      username: row.username || null,
      display_name: row.display_name || null,
      pfp_url: row.pfp_url || null,
      bio: row.bio || null,
      profile_source: row.profile_source || null,
      created_at: row.created_at,
      primary_address: row.primary_address || null,
      q_cost: row.q_cost ?? 3,
      socials: row.socials || null,
      pro_status: row.pro_status || null,
      pro_expires_at: row.pro_expires_at || null,
    };
  }
}
