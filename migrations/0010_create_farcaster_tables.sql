-- Migration number: 0010 	 2025-12-29T00:00:00.000Z
-- Purpose: Create Farcaster integration tables for cast tracking and engagement
-- Related: docs/farcaster/farcaster-schema.sql

-- ============================================================================
-- Table: farcaster_casts
-- Purpose: Track Farcaster cast references for queries and answers
-- ============================================================================

CREATE TABLE IF NOT EXISTS farcaster_casts (
  id TEXT PRIMARY KEY,
  
  -- Reference to qbase entity (query or answer)
  entity_type TEXT NOT NULL CHECK (entity_type IN ('query', 'answer')),
  entity_id TEXT NOT NULL,
  
  -- Farcaster cast data
  cast_hash TEXT NOT NULL,
  cast_url TEXT NOT NULL,
  caster_fid INTEGER NOT NULL,
  
  -- Cast status tracking
  is_active INTEGER DEFAULT 1, -- D1 uses INTEGER for boolean (1=true, 0=false)
  last_checked_at INTEGER, -- Unix timestamp in ms
  
  -- Timestamps
  created_at INTEGER NOT NULL,
  
  -- Ensure one cast per entity
  UNIQUE(entity_type, entity_id)
);

-- Indexes for efficient lookups
CREATE INDEX IF NOT EXISTS idx_farcaster_casts_hash ON farcaster_casts(cast_hash);
CREATE INDEX IF NOT EXISTS idx_farcaster_casts_entity ON farcaster_casts(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_farcaster_casts_active ON farcaster_casts(is_active, last_checked_at);

-- ============================================================================
-- Table: farcaster_reactions
-- Purpose: Store reactions from Farcaster, preserved even if cast disappears
-- ============================================================================

CREATE TABLE IF NOT EXISTS farcaster_reactions (
  id TEXT PRIMARY KEY,
  
  -- Cast reference
  cast_hash TEXT NOT NULL,
  
  -- Reaction data
  reactor_fid INTEGER NOT NULL,
  reaction_type TEXT NOT NULL CHECK (reaction_type IN ('like', 'recast')),
  
  -- Syncing metadata
  synced_at INTEGER NOT NULL, -- When we learned about this reaction
  source TEXT DEFAULT 'farcaster' CHECK (source IN ('farcaster', 'qbase')),
  
  -- Track if this reaction was deleted
  is_deleted INTEGER DEFAULT 0, -- D1 boolean
  deleted_at INTEGER,
  
  -- Timestamps
  created_at INTEGER NOT NULL, -- When reaction was created on Farcaster
  
  -- Prevent duplicate reactions
  UNIQUE(cast_hash, reactor_fid, reaction_type)
);

-- Indexes for efficient lookups
CREATE INDEX IF NOT EXISTS idx_farcaster_reactions_cast ON farcaster_reactions(cast_hash);
CREATE INDEX IF NOT EXISTS idx_farcaster_reactions_fid ON farcaster_reactions(reactor_fid);
CREATE INDEX IF NOT EXISTS idx_farcaster_reactions_deleted ON farcaster_reactions(is_deleted);

-- ============================================================================
-- Table: farcaster_replies
-- Purpose: Store reply casts to preserve conversation context
-- ============================================================================

CREATE TABLE IF NOT EXISTS farcaster_replies (
  id TEXT PRIMARY KEY,
  
  -- Parent cast reference
  parent_cast_hash TEXT NOT NULL,
  
  -- Reply cast data
  reply_cast_hash TEXT NOT NULL UNIQUE,
  author_fid INTEGER NOT NULL,
  text TEXT NOT NULL,
  
  -- Reply status
  is_active INTEGER DEFAULT 1, -- D1 boolean
  last_checked_at INTEGER,
  
  -- Timestamps
  created_at INTEGER NOT NULL,
  synced_at INTEGER NOT NULL
);

-- Indexes for efficient lookups
CREATE INDEX IF NOT EXISTS idx_farcaster_replies_parent ON farcaster_replies(parent_cast_hash);
CREATE INDEX IF NOT EXISTS idx_farcaster_replies_author ON farcaster_replies(author_fid);
CREATE INDEX IF NOT EXISTS idx_farcaster_replies_hash ON farcaster_replies(reply_cast_hash);

-- ============================================================================
-- Table: farcaster_sync_log
-- Purpose: Track webhook deliveries and sync operations for debugging
-- ============================================================================

CREATE TABLE IF NOT EXISTS farcaster_sync_log (
  id TEXT PRIMARY KEY,
  
  -- Event metadata
  event_type TEXT NOT NULL, -- 'cast.created', 'reaction.added', 'cast.deleted', etc.
  cast_hash TEXT,
  
  -- Webhook data
  webhook_id TEXT,
  payload TEXT, -- JSON string (D1 doesn't have native JSONB, use TEXT)
  
  -- Processing status
  processed_at INTEGER NOT NULL,
  success INTEGER DEFAULT 1, -- D1 boolean
  error_message TEXT
);

-- Indexes for efficient lookups
CREATE INDEX IF NOT EXISTS idx_farcaster_sync_log_event ON farcaster_sync_log(event_type, processed_at);
CREATE INDEX IF NOT EXISTS idx_farcaster_sync_log_webhook ON farcaster_sync_log(webhook_id);

-- ============================================================================
-- Rollback (if needed):
-- ============================================================================
-- DROP INDEX IF EXISTS idx_farcaster_sync_log_webhook;
-- DROP INDEX IF EXISTS idx_farcaster_sync_log_event;
-- DROP TABLE IF EXISTS farcaster_sync_log;
-- DROP INDEX IF EXISTS idx_farcaster_replies_hash;
-- DROP INDEX IF EXISTS idx_farcaster_replies_author;
-- DROP INDEX IF EXISTS idx_farcaster_replies_parent;
-- DROP TABLE IF EXISTS farcaster_replies;
-- DROP INDEX IF EXISTS idx_farcaster_reactions_deleted;
-- DROP INDEX IF EXISTS idx_farcaster_reactions_fid;
-- DROP INDEX IF EXISTS idx_farcaster_reactions_cast;
-- DROP TABLE IF EXISTS farcaster_reactions;
-- DROP INDEX IF EXISTS idx_farcaster_casts_active;
-- DROP INDEX IF EXISTS idx_farcaster_casts_entity;
-- DROP INDEX IF EXISTS idx_farcaster_casts_hash;
-- DROP TABLE IF EXISTS farcaster_casts;

