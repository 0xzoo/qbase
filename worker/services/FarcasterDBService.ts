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
    db: D1Database,
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
      .first<any>();

    return this.parseCast(result);
  }

  /**
   * Get cast reference for an entity.
   */
  static async getCast(
    db: D1Database,
    entity_type: 'query' | 'answer',
    entity_id: string
  ): Promise<FarcasterCast | null> {
    const query = `
      SELECT * FROM farcaster_casts
      WHERE entity_type = ?1 AND entity_id = ?2
    `;

    const result = await db.prepare(query)
      .bind(entity_type, entity_id)
      .first<any>();

    return result ? this.parseCast(result) : null;
  }

  /**
   * Get cast by hash.
   */
  static async getCastByHash(
    db: D1Database,
    cast_hash: string
  ): Promise<FarcasterCast | null> {
    const query = `
      SELECT * FROM farcaster_casts
      WHERE cast_hash = ?1
    `;

    const result = await db.prepare(query)
      .bind(cast_hash)
      .first<any>();

    return result ? this.parseCast(result) : null;
  }

  /**
   * Update cast health status.
   */
  static async updateCastHealth(
    db: D1Database,
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
    db: D1Database,
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
      .all<any>();

    return result.results.map(r => this.parseCast(r));
  }

  /**
   * Add a reaction to a cast.
   */
  static async upsertReaction(
    db: D1Database,
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
      .first<any>();

    return this.parseReaction(result);
  }

  /**
   * Remove/soft-delete a reaction.
   */
  static async deleteReaction(
    db: D1Database,
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
    db: D1Database,
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
      .first<any>();

    return this.parseReply(result);
  }

  /**
   * Get engagement data for an entity.
   */
  static async getEngagementData(
    db: D1Database,
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
      .first<any>();

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
      .all<any>();

    // Get recent replies (last 5)
    const repliesQuery = `
      SELECT * FROM farcaster_replies
      WHERE parent_cast_hash = ?1
      ORDER BY created_at DESC
      LIMIT 5
    `;
    const repliesResult = await db.prepare(repliesQuery)
      .bind(cast.cast_hash)
      .all<any>();

    return {
      cast,
      total_likes: parseInt(counts.likes) || 0,
      total_recasts: parseInt(counts.recasts) || 0,
      total_replies: parseInt(counts.replies) || 0,
      recent_reactions: reactionsResult.results.map(r => this.parseReaction(r)),
      recent_replies: repliesResult.results.map(r => this.parseReply(r)),
    };
  }

  /**
   * Log a sync event for debugging.
   */
  static async logSyncEvent(
    db: D1Database,
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
      .first<any>();

    return this.parseSyncEvent(result);
  }

  /**
   * Check if webhook was already processed (idempotency).
   */
  static async wasWebhookProcessed(
    db: D1Database,
    webhook_id: string
  ): Promise<boolean> {
    const query = `
      SELECT COUNT(*) as count 
      FROM farcaster_sync_log 
      WHERE webhook_id = ?1
    `;

    const result = await db.prepare(query)
      .bind(webhook_id)
      .first<{ count: number }>();

    return (result?.count || 0) > 0;
  }

  /**
   * Get reactions by user.
   */
  static async getUserReactions(
    db: D1Database,
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
      .all<any>();

    return result.results.map(r => ({
      ...this.parseReaction(r),
      entity_type: r.entity_type,
      entity_id: r.entity_id,
    }));
  }

  // ============================================================================
  // D1 Parsing Helpers (convert INTEGER booleans, parse JSON, etc.)
  // ============================================================================

  private static parseCast(row: any): FarcasterCast {
    return {
      id: row.id,
      entity_type: row.entity_type,
      entity_id: row.entity_id,
      cast_hash: row.cast_hash,
      cast_url: row.cast_url,
      caster_fid: row.caster_fid,
      is_active: row.is_active === 1,
      last_checked_at: row.last_checked_at,
      created_at: row.created_at,
    };
  }

  private static parseReaction(row: any): FarcasterReaction {
    return {
      id: row.id,
      cast_hash: row.cast_hash,
      reactor_fid: row.reactor_fid,
      reaction_type: row.reaction_type,
      synced_at: row.synced_at,
      source: row.source,
      is_deleted: row.is_deleted === 1,
      deleted_at: row.deleted_at,
      created_at: row.created_at,
    };
  }

  private static parseReply(row: any): FarcasterReply {
    return {
      id: row.id,
      parent_cast_hash: row.parent_cast_hash,
      reply_cast_hash: row.reply_cast_hash,
      author_fid: row.author_fid,
      text: row.text,
      is_active: row.is_active === 1,
      last_checked_at: row.last_checked_at,
      created_at: row.created_at,
      synced_at: row.synced_at,
    };
  }

  private static parseSyncEvent(row: any): FarcasterSyncEvent {
    return {
      id: row.id,
      event_type: row.event_type,
      cast_hash: row.cast_hash,
      webhook_id: row.webhook_id,
      payload: row.payload ? JSON.parse(row.payload) : undefined,
      processed_at: row.processed_at,
      success: row.success === 1,
      error_message: row.error_message,
    };
  }
}
