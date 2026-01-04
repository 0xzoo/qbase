// @ts-nocheck
/**
 * Farcaster Database Service (Cloudflare D1)
 * 
 * Helpers for interacting with Farcaster integration tables in D1.
 * Supports cast tracking, engagement data, and bidirectional sync.
 * 
 * D1 Specifics:
 * - UUIDs are TEXT type (use crypto.randomUUID())
 * - Booleans are INTEGER (0=false, 1=true)
 * - JSON is TEXT type (parse/stringify manually)
 */

import type {
  FarcasterCast,
  FarcasterReaction,
  FarcasterReply,
  FarcasterEngagementData,
  FarcasterSyncEvent,
} from '../../src/lib/types';

/**
 * TTL for cast health checks (24 hours in milliseconds)
 */
export const CAST_CHECK_TTL = 24 * 60 * 60 * 1000;

/**
 * Service for managing Farcaster casts, reactions, and engagement.
 */
export class FarcasterDBService {
  /**
   * Create or update a cast reference for an entity (query or answer).
   */
  static async upsertCast(
    db: any,
    params: {
      entity_type: 'query' | 'answer';
      entity_id: string;
      cast_hash: string;
      cast_url: string;
      caster_fid: number;
    }
  ): Promise<FarcasterCast> {
    const now = Date.now();
    const id = crypto.randomUUID();

    const query = `
      INSERT INTO farcaster_casts (
        id, entity_type, entity_id, cast_hash, cast_url, 
        caster_fid, created_at, is_active
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1)
      ON CONFLICT (entity_type, entity_id) 
      DO UPDATE SET 
        cast_hash = excluded.cast_hash,
        cast_url = excluded.cast_url,
        caster_fid = excluded.caster_fid,
        is_active = 1
      RETURNING *
    `;

    const result = await db.prepare(query)
      .bind(
        id,
        params.entity_type,
        params.entity_id,
        params.cast_hash,
        params.cast_url,
        params.caster_fid,
        now
      )
      .first();

    if (!result) return null;
    return this.parseCast(result);
  }

  /**
   * Get cast reference for an entity.
   */
  static async getCast(
    db: any,
    entity_type: 'query' | 'answer',
    entity_id: string
  ): Promise<FarcasterCast | null> {
    const query = `
      SELECT * FROM farcaster_casts
      WHERE entity_type = ?1 AND entity_id = ?2
    `;

    const result = await db.prepare(query)
      .bind(entity_type, entity_id)
      .first();

    return result ? this.parseCast(result) : null;
  }

  /**
   * Get cast by hash.
   */
  static async getCastByHash(
    db: any,
    cast_hash: string
  ): Promise<FarcasterCast | null> {
    const query = `
      SELECT * FROM farcaster_casts
      WHERE cast_hash = ?1
    `;

    const result = await db.prepare(query)
      .bind(cast_hash)
      .first();

    return result ? this.parseCast(result) : null;
  }

  /**
   * Update cast health status.
   */
  static async updateCastHealth(
    db: any,
    cast_hash: string,
    is_active: boolean
  ): Promise<void> {
    const query = `
      UPDATE farcaster_casts
      SET is_active = ?1, last_checked_at = ?2
      WHERE cast_hash = ?3
    `;

    await db.prepare(query)
      .bind(is_active ? 1 : 0, Date.now(), cast_hash)
      .run();
  }

  /**
   * Check if cast needs health check (TTL expired).
   */
  static needsHealthCheck(cast: FarcasterCast): boolean {
    if (!cast.last_checked_at) return true;
    return Date.now() - cast.last_checked_at > CAST_CHECK_TTL;
  }

  /**
   * Get casts that need health checking.
   */
  static async getCastsNeedingHealthCheck(
    db: any,
    limit: number = 100
  ): Promise<FarcasterCast[]> {
    const ttlThreshold = Date.now() - CAST_CHECK_TTL;

    const query = `
      SELECT * FROM farcaster_casts
      WHERE is_active = 1
        AND (last_checked_at IS NULL OR last_checked_at < ?1)
      ORDER BY last_checked_at ASC
      LIMIT ?2
    `;

    const result = await db.prepare(query)
      .bind(ttlThreshold, limit)
      .all();

    return result.results.map(r => this.parseCast(r));
  }

  /**
   * Add a reaction to a cast.
   */
  static async upsertReaction(
    db: any,
    params: {
      cast_hash: string;
      reactor_fid: number;
      reaction_type: 'like' | 'recast';
      source?: 'farcaster' | 'qbase';
    }
  ): Promise<FarcasterReaction> {
    const now = Date.now();
    const id = crypto.randomUUID();

    const query = `
      INSERT INTO farcaster_reactions (
        id, cast_hash, reactor_fid, reaction_type, 
        created_at, synced_at, source, is_deleted
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0)
      ON CONFLICT (cast_hash, reactor_fid, reaction_type)
      DO UPDATE SET 
        is_deleted = 0,
        deleted_at = NULL,
        synced_at = excluded.synced_at
      RETURNING *
    `;

    const result = await db.prepare(query)
      .bind(
        id,
        params.cast_hash,
        params.reactor_fid,
        params.reaction_type,
        now,
        now,
        params.source || 'farcaster'
      )
      .first();

    if (!result) return null;
    return this.parseReaction(result);
  }

  /**
   * Remove/soft-delete a reaction.
   */
  static async deleteReaction(
    db: any,
    cast_hash: string,
    reactor_fid: number,
    reaction_type: 'like' | 'recast'
  ): Promise<void> {
    const query = `
      UPDATE farcaster_reactions
      SET is_deleted = 1, deleted_at = ?1
      WHERE cast_hash = ?2 
        AND reactor_fid = ?3 
        AND reaction_type = ?4
    `;

    await db.prepare(query)
      .bind(Date.now(), cast_hash, reactor_fid, reaction_type)
      .run();
  }

  /**
   * Add a reply to a cast.
   */
  static async addReply(
    db: any,
    params: {
      parent_cast_hash: string;
      reply_cast_hash: string;
      author_fid: number;
      text: string;
    }
  ): Promise<FarcasterReply> {
    const now = Date.now();
    const id = crypto.randomUUID();

    const query = `
      INSERT INTO farcaster_replies (
        id, parent_cast_hash, reply_cast_hash, author_fid, 
        text, created_at, synced_at, is_active
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1)
      ON CONFLICT (reply_cast_hash) 
      DO UPDATE SET 
        is_active = 1,
        synced_at = excluded.synced_at
      RETURNING *
    `;

    const result = await db.prepare(query)
      .bind(
        id,
        params.parent_cast_hash,
        params.reply_cast_hash,
        params.author_fid,
        params.text,
        now,
        now
      )
      .first();

    if (!result) return null;
    return this.parseReply(result);
  }

  /**
   * Get engagement data for an entity.
   */
  static async getEngagementData(
    db: any,
    entity_type: 'query' | 'answer',
    entity_id: string
  ): Promise<FarcasterEngagementData> {
    // Get cast
    const cast = await this.getCast(db, entity_type, entity_id);

    if (!cast) {
      return {
        total_likes: 0,
        total_recasts: 0,
        total_replies: 0,
      };
    }

    // Get aggregated counts
    const countsQuery = `
      SELECT 
        SUM(CASE WHEN fr.reaction_type = 'like' AND fr.is_deleted = 0 THEN 1 ELSE 0 END) as likes,
        SUM(CASE WHEN fr.reaction_type = 'recast' AND fr.is_deleted = 0 THEN 1 ELSE 0 END) as recasts,
        COUNT(DISTINCT frp.id) as replies
      FROM farcaster_casts fc
      LEFT JOIN farcaster_reactions fr ON fc.cast_hash = fr.cast_hash
      LEFT JOIN farcaster_replies frp ON fc.cast_hash = frp.parent_cast_hash
      WHERE fc.cast_hash = ?1
      GROUP BY fc.cast_hash
    `;

    const countsResult = await db.prepare(countsQuery)
      .bind(cast.cast_hash)
      .first();

    const counts = countsResult || { likes: 0, recasts: 0, replies: 0 };

    // Get recent reactions (last 10)
    const reactionsQuery = `
      SELECT * FROM farcaster_reactions
      WHERE cast_hash = ?1 AND is_deleted = 0
      ORDER BY created_at DESC
      LIMIT 10
    `;
    const reactionsResult = await db.prepare(reactionsQuery)
      .bind(cast.cast_hash)
      .all();

    // Get recent replies (last 5)
    const repliesQuery = `
      SELECT * FROM farcaster_replies
      WHERE parent_cast_hash = ?1
      ORDER BY created_at DESC
      LIMIT 5
    `;
    const repliesResult = await db.prepare(repliesQuery)
      .bind(cast.cast_hash)
      .all();

    return {
      cast,
      total_likes: parseInt(counts.likes as string) || 0,
      total_recasts: parseInt(counts.recasts as string) || 0,
      total_replies: parseInt(counts.replies as string) || 0,
      recent_reactions: reactionsResult.results.map((r: any) => this.parseReaction(r)),
      recent_replies: repliesResult.results.map((r: any) => this.parseReply(r)),
    };
  }

  /**
   * Log a sync event for debugging.
   */
  static async logSyncEvent(
    db: any,
    params: {
      event_type: string;
      cast_hash?: string;
      webhook_id?: string;
      payload?: object;
      success: boolean;
      error_message?: string;
    }
  ): Promise<FarcasterSyncEvent> {
    const id = crypto.randomUUID();

    const query = `
      INSERT INTO farcaster_sync_log (
        id, event_type, cast_hash, webhook_id, 
        payload, processed_at, success, error_message
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
      RETURNING *
    `;

    const result = await db.prepare(query)
      .bind(
        id,
        params.event_type,
        params.cast_hash || null,
        params.webhook_id || null,
        params.payload ? JSON.stringify(params.payload) : null,
        Date.now(),
        params.success ? 1 : 0,
        params.error_message || null
      )
      .first();

    if (!result) return null;
    return this.parseSyncEvent(result);
  }

  /**
   * Check if webhook was already processed (idempotency).
   */
  static async wasWebhookProcessed(
    db: any,
    webhook_id: string
  ): Promise<boolean> {
    const query = `
      SELECT COUNT(*) as count 
      FROM farcaster_sync_log 
      WHERE webhook_id = ?1
    `;

    const result = await db.prepare(query)
      .bind(webhook_id)
      .first();

    return (result?.count || 0) > 0;
  }

  /**
   * Update cached Farcaster engagement stats for a cast.
   * Called when fresh data is fetched from Farcaster API.
   */
  static async updateCachedStats(
    db: any,
    cast_hash: string,
    stats: {
      likes_count: number;
      recasts_count: number;
      replies_count: number;
    }
  ): Promise<boolean> {
    const now = Date.now();

    const query = `
      UPDATE farcaster_casts
      SET 
        cached_likes_count = ?1,
        cached_recasts_count = ?2,
        cached_replies_count = ?3,
        stats_synced_at = ?4
      WHERE cast_hash = ?5
    `;

    const result = await db.prepare(query)
      .bind(
        stats.likes_count,
        stats.recasts_count,
        stats.replies_count,
        now,
        cast_hash
      )
      .run();

    return result.meta?.changes > 0;
  }

  /**
   * Get cached Farcaster stats for an entity.
   */
  static async getCachedStats(
    db: any,
    entity_type: 'query' | 'answer',
    entity_id: string
  ): Promise<{
    likes_count: number;
    recasts_count: number;
    replies_count: number;
    synced_at: number | null;
  } | null> {
    const query = `
      SELECT 
        cached_likes_count,
        cached_recasts_count,
        cached_replies_count,
        stats_synced_at
      FROM farcaster_casts
      WHERE entity_type = ?1 AND entity_id = ?2
    `;

    const result = await db.prepare(query)
      .bind(entity_type, entity_id)
      .first();

    if (!result) return null;

    return {
      likes_count: (result.cached_likes_count as number) || 0,
      recasts_count: (result.cached_recasts_count as number) || 0,
      replies_count: (result.cached_replies_count as number) || 0,
      synced_at: result.stats_synced_at as number | null,
    };
  }

  /**
   * Get reactions by user.
   */
  static async getUserReactions(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: any,
    fid: number,
    limit: number = 50
  ): Promise<Array<FarcasterReaction & { entity_type: string; entity_id: string }>> {
    const query = `
      SELECT 
        fr.*,
        fc.entity_type,
        fc.entity_id
      FROM farcaster_reactions fr
      JOIN farcaster_casts fc ON fr.cast_hash = fc.cast_hash
      WHERE fr.reactor_fid = ?1
        AND fr.is_deleted = 0
      ORDER BY fr.created_at DESC
      LIMIT ?2
    `;

    const result = await db.prepare(query)
      .bind(fid, limit)
      .all();

    return result.results.map((r: Record<string, unknown>) => ({
      ...this.parseReaction(r),
      entity_type: r.entity_type as string,
      entity_id: r.entity_id as string,
    }));
  }

  // ============================================================================
  // D1 Parsing Helpers (convert INTEGER booleans, parse JSON, etc.)
  // ============================================================================

  private static parseCast(row: Record<string, unknown>): FarcasterCast {
    return {
      id: row.id as string,
      entity_type: row.entity_type as 'query' | 'answer',
      entity_id: row.entity_id as string,
      cast_hash: row.cast_hash as string,
      cast_url: row.cast_url as string,
      caster_fid: row.caster_fid as number,
      is_active: row.is_active === 1,
      last_checked_at: row.last_checked_at as number | undefined,
      created_at: row.created_at as number,
    };
  }

  private static parseReaction(row: Record<string, unknown>): FarcasterReaction {
    return {
      id: row.id as string,
      cast_hash: row.cast_hash as string,
      reactor_fid: row.reactor_fid as number,
      reaction_type: row.reaction_type as 'like' | 'recast',
      synced_at: row.synced_at as number,
      source: row.source as 'qbase' | 'farcaster',
      is_deleted: row.is_deleted === 1,
      deleted_at: row.deleted_at as number | undefined,
      created_at: row.created_at as number,
    };
  }

  private static parseReply(row: Record<string, unknown>): FarcasterReply {
    return {
      id: row.id as string,
      parent_cast_hash: row.parent_cast_hash as string,
      reply_cast_hash: row.reply_cast_hash as string,
      author_fid: row.author_fid as number,
      text: row.text as string,
      is_active: row.is_active === 1,
      last_checked_at: row.last_checked_at as number | undefined,
      created_at: row.created_at as number,
      synced_at: row.synced_at as number,
    };
  }

  private static parseSyncEvent(row: Record<string, unknown>): FarcasterSyncEvent {
    return {
      id: row.id as string,
      event_type: row.event_type as string | undefined,
      cast_hash: row.cast_hash as string | undefined,
      webhook_id: row.webhook_id as string | undefined,
      payload: row.payload ? JSON.parse(row.payload as string) as Record<string, unknown> : undefined,
      processed_at: row.processed_at as number,
      success: row.success === 1,
      error_message: row.error_message as string | undefined,
    };
  }
}
