// @ts-nocheck
import type { Allowlist, AllowlistWithMembers, AllowlistType } from '../../src/lib/types';
import crypto from 'crypto';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

export class AllowlistService {
  /**
   * Create a new allowlist
   */
  static async create(
    env: Env,
    userId: number,
    data: {
      name: string;
      description?: string;
      list_type: AllowlistType;
      source_params?: { fid?: number; limit?: number };
      members?: number[]; // Internal user IDs for manual/besties types
    }
  ): Promise<Allowlist> {
    const id = crypto.randomUUID();
    const now = Date.now();

    // Validate members based on list_type
    if (data.list_type === 'manual' && data.members) {
      if (data.members.length > 100) {
        throw new Error('Manual allowlists cannot exceed 100 members');
      }
    } else if (data.list_type === 'besties' && data.members) {
      if (data.members.length > 50) {
        throw new Error('Besties allowlists cannot exceed 50 members');
      }
    } else if (['my_followers', 'my_following', 'mutual_followers'].includes(data.list_type)) {
      // Dynamic lists should have no stored members
      data.members = undefined;
    }

    const membersJson = data.members ? JSON.stringify(data.members) : null;
    const sourceParamsJson = data.source_params ? JSON.stringify(data.source_params) : null;

    await env.DB.prepare(`
      INSERT INTO allowlists (id, user_id, name, description, list_type, source_params, members, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      userId,
      data.name,
      data.description || null,
      data.list_type,
      sourceParamsJson,
      membersJson,
      now,
      now
    ).run();

    return {
      id,
      user_id: userId,
      name: data.name,
      description: data.description,
      list_type: data.list_type,
      source_params: sourceParamsJson || undefined,
      members: membersJson || undefined,
      created_at: now,
      updated_at: now,
    };
  }

  /**
   * List all allowlists for a user
   */
  static async list(env: Env, userId: number): Promise<AllowlistWithMembers[]> {
    const { results } = await env.DB.prepare(`
      SELECT * FROM allowlists
      WHERE user_id = ?
      ORDER BY updated_at DESC
    `).bind(userId).all();

    return results.map((row: Record<string, unknown>) => {
      const memberIds = row.members ? JSON.parse(row.members) : undefined;
      return {
        ...row,
        memberIds,
        memberCount: memberIds?.length || 0,
      };
    });
  }

  /**
   * Get a specific allowlist
   */
  static async get(env: Env, allowlistId: string, userId: number): Promise<AllowlistWithMembers | null> {
    const row = await env.DB.prepare(`
      SELECT * FROM allowlists
      WHERE id = ? AND user_id = ?
    `).bind(allowlistId, userId).first();

    if (!row) return null;

    const memberIds = row.members ? JSON.parse(row.members) : undefined;
    return {
      ...row,
      memberIds,
      memberCount: memberIds?.length || 0,
    };
  }

  /**
   * Update an allowlist (manual lists only)
   */
  static async update(
    env: Env,
    allowlistId: string,
    userId: number,
    data: {
      name?: string;
      description?: string;
      members?: number[]; // For manual lists only
    }
  ): Promise<Allowlist> {
    // Get existing allowlist
    const existing = await this.get(env, allowlistId, userId);
    if (!existing) {
      throw new Error('Allowlist not found');
    }

    // Only manual lists can be edited
    if (existing.list_type !== 'manual') {
      throw new Error('Only manual allowlists can be edited directly');
    }

    // Validate member count
    if (data.members && data.members.length > 100) {
      throw new Error('Manual allowlists cannot exceed 100 members');
    }

    const now = Date.now();
    const membersJson = data.members ? JSON.stringify(data.members) : existing.members;

    await env.DB.prepare(`
      UPDATE allowlists
      SET name = ?, description = ?, members = ?, updated_at = ?
      WHERE id = ? AND user_id = ?
    `).bind(
      data.name || existing.name,
      data.description !== undefined ? data.description : existing.description,
      membersJson,
      now,
      allowlistId,
      userId
    ).run();

    return {
      ...existing,
      name: data.name || existing.name,
      description: data.description !== undefined ? data.description : existing.description,
      members: membersJson,
      updated_at: now,
    };
  }

  /**
   * Delete an allowlist
   */
  static async delete(env: Env, allowlistId: string, userId: number): Promise<void> {
    await env.DB.prepare(`
      DELETE FROM allowlists
      WHERE id = ? AND user_id = ?
    `).bind(allowlistId, userId).run();
  }

  /**
   * Refresh a besties allowlist from Neynar
   */
  static async refreshFromNeynar(
    env: Env,
    allowlistId: string,
    userId: number,
    importBestiesFn: (fid: number, limit: number) => Promise<number[]>
  ): Promise<Allowlist> {
    const existing = await this.get(env, allowlistId, userId);
    if (!existing) {
      throw new Error('Allowlist not found');
    }

    if (existing.list_type !== 'besties') {
      throw new Error('Only besties allowlists can be refreshed');
    }

    const sourceParams = existing.source_params ? JSON.parse(existing.source_params) : {};
    if (!sourceParams.fid) {
      throw new Error('Missing FID in source parameters');
    }

    // Fetch fresh besties from Neynar
    const fids = await importBestiesFn(sourceParams.fid, sourceParams.limit || 50);
    const userIds = await this.resolveFidsToUserIds(env, fids);

    const now = Date.now();
    const membersJson = JSON.stringify(userIds);

    await env.DB.prepare(`
      UPDATE allowlists
      SET members = ?, updated_at = ?
      WHERE id = ? AND user_id = ?
    `).bind(membersJson, now, allowlistId, userId).run();

    return {
      ...existing,
      members: membersJson,
      updated_at: now,
    };
  }

  /**
   * Get member IDs for an allowlist
   */
  static async getMembers(env: Env, allowlistId: string): Promise<number[]> {
    const allowlist = await env.DB.prepare(`
      SELECT members FROM allowlists WHERE id = ?
    `).bind(allowlistId).first();

    if (!allowlist || !allowlist.members) {
      return [];
    }

    return JSON.parse(allowlist.members);
  }

  /**
   * Check if a user is a member of an allowlist (main access control logic)
   */
  static async checkMembership(
    env: Env,
    allowlistId: string,
    requesterUserId: number,
    checkNeynarRelationshipFn?: (ownerFid: number, requesterFid: number, relationType: string) => Promise<boolean>
  ): Promise<boolean> {
    // Try cache first
    const cacheKey = `allowlist:membership:${allowlistId}:${requesterUserId}`;
    const cached = await env.KV_USER_PROFILES?.get(cacheKey);
    if (cached !== null) {
      return cached === '1';
    }

    // Get allowlist
    const allowlist = await env.DB.prepare(`
      SELECT * FROM allowlists WHERE id = ?
    `).bind(allowlistId).first();

    if (!allowlist) {
      return false;
    }

    let isMember = false;

    // Check based on list_type
    if (allowlist.list_type === 'manual' || allowlist.list_type === 'besties') {
      // Static lists: check members array
      if (allowlist.members) {
        const memberIds: number[] = JSON.parse(allowlist.members);
        isMember = memberIds.includes(requesterUserId);
      }
    } else if (checkNeynarRelationshipFn) {
      // Dynamic lists: check via Neynar
      const sourceParams = allowlist.source_params ? JSON.parse(allowlist.source_params) : {};
      const ownerFid = sourceParams.fid;

      if (ownerFid) {
        // Get requester's FID
        const requesterUser = await env.DB.prepare(`
          SELECT fid FROM users WHERE id = ?
        `).bind(requesterUserId).first();

        if (requesterUser?.fid) {
          isMember = await checkNeynarRelationshipFn(ownerFid, requesterUser.fid, allowlist.list_type);
        }
      }
    }

    // Cache result for 5 minutes (static lists) or 10 minutes (dynamic lists)
    const cacheDuration = ['manual', 'besties'].includes(allowlist.list_type) ? 300 : 600;
    await env.KV_USER_PROFILES?.put(cacheKey, isMember ? '1' : '0', { expirationTtl: cacheDuration });

    return isMember;
  }

  /**
   * Translate array of FIDs to internal user IDs
   */
  static async resolveFidsToUserIds(env: Env, fids: number[]): Promise<number[]> {
    if (fids.length === 0) return [];

    // Batch query to get internal user IDs for FIDs
    const placeholders = fids.map(() => '?').join(',');
    const { results } = await env.DB.prepare(`
      SELECT id, fid FROM users
      WHERE fid IN (${placeholders})
    `).bind(...fids).all();

    // Create a map of fid -> user_id
    const fidToIdMap = new Map<number, number>();
    results.forEach((row: Record<string, unknown>) => {
      fidToIdMap.set(row.fid as number, row.id as number);
    });

    // Translate FIDs to user IDs (skip FIDs not in our system)
    const userIds: number[] = [];
    for (const fid of fids) {
      const userId = fidToIdMap.get(fid);
      if (userId) {
        userIds.push(userId);
      } else {
        console.warn(`FID ${fid} not found in users table, skipping`);
      }
    }

    return userIds;
  }

  /**
   * Check one-off allowlist (static FID array)
   */
  static async checkStaticAllowlist(
    allowedUserIds: number[],
    requesterUserId: number
  ): Promise<boolean> {
    return allowedUserIds.includes(requesterUserId);
  }
}
