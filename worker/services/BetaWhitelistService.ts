/**
 * Beta Whitelist Service
 * 
 * Manages the beta access whitelist. This is a temporary service
 * that controls who can create accounts during the beta period.
 * 
 * Now supports automatic access based on Neynar user quality score.
 */

import { NeynarService } from '../../src/services/NeynarService';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

export interface WhitelistEntry {
  id: number;
  fid: number;
  fname: string | null;
  added_by_fid: number | null;
  added_at: number;
  notes: string | null;
}

// Admin FIDs who can manage the whitelist
// These users have full access to add/remove from the whitelist
const ADMIN_FIDS = [
  10215, // zoo 
];

// Minimum Neynar score required for automatic beta access
const MINIMUM_NEYNAR_SCORE = 0.9;

export class BetaWhitelistService {
  /**
   * Check if a FID is whitelisted for beta access
   * 
   * Access is granted if any of the following are true:
   * 1. User is an admin
   * 2. User has a Neynar score > 0.9
   * 3. User is in the manual whitelist (legacy)
   */
  static async isWhitelisted(env: Env, fid: number): Promise<boolean> {
    // Admins are always whitelisted
    if (ADMIN_FIDS.includes(fid)) {
      console.log(`[BetaWhitelist] ✅ Admin FID ${fid} granted access`);
      return true;
    }

    try {
      // Check Neynar score first (fastest path for most users)
      if (env.NEYNAR_API_KEY) {
        try {
          const user = await NeynarService.fetchUser(String(fid), env.NEYNAR_API_KEY);
          const neynarScore = user.score;
          
          if (neynarScore !== undefined && neynarScore > MINIMUM_NEYNAR_SCORE) {
            console.log(`[BetaWhitelist] ✅ FID ${fid} granted access via Neynar score: ${neynarScore}`);
            return true;
          } else if (neynarScore !== undefined) {
            console.log(`[BetaWhitelist] ❌ FID ${fid} score ${neynarScore} below threshold ${MINIMUM_NEYNAR_SCORE}`);
          } else {
            console.log(`[BetaWhitelist] ⚠️ FID ${fid} has no Neynar score`);
          }
        } catch (neynarError) {
          console.error('[BetaWhitelist] Error fetching Neynar score:', neynarError);
          // Continue to check manual whitelist on Neynar error
        }
      }

      // Fallback: Check manual whitelist
      const result = await env.DB.prepare(`
        SELECT 1 FROM beta_whitelist WHERE fid = ?
      `).bind(fid).first();

      const isInWhitelist = !!result;
      if (isInWhitelist) {
        console.log(`[BetaWhitelist] ✅ FID ${fid} granted access via manual whitelist`);
      } else {
        console.log(`[BetaWhitelist] ❌ FID ${fid} denied access`);
      }

      return isInWhitelist;
    } catch (error) {
      console.error('[BetaWhitelist] Error checking whitelist:', error);
      // Fail closed in case of error (deny access)
      return false;
    }
  }

  /**
   * Check if a FID is an admin
   */
  static isAdmin(fid: number): boolean {
    return ADMIN_FIDS.includes(fid);
  }

  /**
   * Add a single FID to the whitelist
   */
  static async addToWhitelist(
    env: Env,
    fid: number,
    addedByFid: number,
    fname?: string,
    notes?: string
  ): Promise<WhitelistEntry | null> {
    try {
      const result = await env.DB.prepare(`
        INSERT INTO beta_whitelist (fid, fname, added_by_fid, notes)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(fid) DO UPDATE SET
          fname = COALESCE(excluded.fname, beta_whitelist.fname),
          notes = COALESCE(excluded.notes, beta_whitelist.notes)
        RETURNING *
      `).bind(fid, fname || null, addedByFid, notes || null).first();

      if (result) {
        console.log(`[BetaWhitelist] ✅ Added FID ${fid} to whitelist`);
        return this.parseEntry(result);
      }
      return null;
    } catch (error) {
      console.error('[BetaWhitelist] Error adding to whitelist:', error);
      throw error;
    }
  }

  /**
   * Add multiple FIDs to the whitelist in bulk
   * @param fidList - Comma-separated list of FIDs
   * @param fetchUsername - Optional function to fetch username from Neynar
   */
  static async addBulkToWhitelist(
    env: Env,
    fidList: string,
    addedByFid: number,
    fetchUsername?: (fid: number) => Promise<string | undefined>
  ): Promise<{ added: number[]; failed: string[] }> {
    const added: number[] = [];
    const failed: string[] = [];

    // Parse comma-separated list
    const parts = fidList.split(',').map(s => s.trim()).filter(s => s.length > 0);

    for (const part of parts) {
      const fid = parseInt(part, 10);
      if (isNaN(fid) || fid <= 0) {
        failed.push(part);
        continue;
      }

      try {
        // Fetch username if fetcher provided
        let fname: string | undefined;
        if (fetchUsername) {
          fname = await fetchUsername(fid);
        }
        
        await this.addToWhitelist(env, fid, addedByFid, fname);
        added.push(fid);
      } catch (error) {
        console.error(`[BetaWhitelist] Failed to add FID ${fid}:`, error);
        failed.push(part);
      }
    }

    return { added, failed };
  }

  /**
   * Remove a FID from the whitelist
   */
  static async removeFromWhitelist(env: Env, fid: number): Promise<boolean> {
    try {
      const result = await env.DB.prepare(`
        DELETE FROM beta_whitelist WHERE fid = ?
      `).bind(fid).run();

      const deleted = result.meta?.changes > 0;
      if (deleted) {
        console.log(`[BetaWhitelist] ✅ Removed FID ${fid} from whitelist`);
      }
      return deleted;
    } catch (error) {
      console.error('[BetaWhitelist] Error removing from whitelist:', error);
      throw error;
    }
  }

  /**
   * Get all whitelisted entries
   */
  static async listWhitelist(
    env: Env,
    limit: number = 100,
    offset: number = 0
  ): Promise<{ entries: WhitelistEntry[]; total: number }> {
    try {
      // Get total count
      const countResult = await env.DB.prepare(`
        SELECT COUNT(*) as count FROM beta_whitelist
      `).first() as { count: number } | null;
      const total = countResult?.count || 0;

      // Get entries
      const results = await env.DB.prepare(`
        SELECT * FROM beta_whitelist
        ORDER BY added_at DESC
        LIMIT ? OFFSET ?
      `).bind(limit, offset).all();

      const entries = (results.results || []).map((row: any) => this.parseEntry(row));

      return { entries, total };
    } catch (error) {
      console.error('[BetaWhitelist] Error listing whitelist:', error);
      throw error;
    }
  }

  /**
   * Parse database row into WhitelistEntry
   */
  private static parseEntry(row: any): WhitelistEntry {
    return {
      id: row.id,
      fid: row.fid,
      fname: row.fname || null,
      added_by_fid: row.added_by_fid || null,
      added_at: row.added_at,
      notes: row.notes || null,
    };
  }
}

