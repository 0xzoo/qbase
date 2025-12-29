-- Migration number: 0006 	 2025-12-27T00:00:00.000Z
-- Purpose: Create direct_queries table for user-to-user direct questioning with payment escrow
-- Related: docs/TODO.md (Direct Queries Payment System), FEATURES.md

-- Direct queries table for user-to-user questioning with payment system
CREATE TABLE IF NOT EXISTS direct_queries (
  id TEXT PRIMARY KEY,
  sender_id INTEGER NOT NULL,
  recipient_id INTEGER NOT NULL,
  q_id TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  answered BOOLEAN DEFAULT FALSE,
  removed BOOLEAN DEFAULT FALSE,
  cost INTEGER NOT NULL,
  -- Payment escrow fields
  payment_type TEXT NOT NULL DEFAULT 'qp', -- 'qp' for Query Points or 'qq' for $QQ tokens
  payment_status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'escrowed', 'released', 'refunded'
  escrow_amount INTEGER, -- Amount in escrow (may differ from cost if counter-offered)
  escrow_tx TEXT, -- Transaction hash for $QQ token escrow (if applicable)
  escrowed_at INTEGER, -- Timestamp when payment was escrowed
  released_at INTEGER, -- Timestamp when payment was released to recipient
  refunded_at INTEGER, -- Timestamp when payment was refunded to sender
  -- Custom pricing (if recipient has custom pricing config)
  custom_pricing_applied BOOLEAN DEFAULT FALSE,
  base_cost INTEGER, -- Original cost before custom pricing
  -- Farcaster integration
  casthash TEXT, -- Farcaster cast hash if published
  -- Metadata
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (q_id) REFERENCES queries(id) ON DELETE CASCADE
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_direct_queries_sender ON direct_queries(sender_id);
CREATE INDEX IF NOT EXISTS idx_direct_queries_recipient ON direct_queries(recipient_id);
CREATE INDEX IF NOT EXISTS idx_direct_queries_query ON direct_queries(q_id);
CREATE INDEX IF NOT EXISTS idx_direct_queries_payment_status ON direct_queries(payment_status);
CREATE INDEX IF NOT EXISTS idx_direct_queries_answered ON direct_queries(answered);
CREATE INDEX IF NOT EXISTS idx_direct_queries_sent_at ON direct_queries(sent_at);
-- Composite index for recipient inbox queries (most common use case)
CREATE INDEX IF NOT EXISTS idx_direct_queries_recipient_status 
ON direct_queries(recipient_id, payment_status, answered)
WHERE removed = FALSE;

-- Migration validation queries:
-- Verify table: SELECT name FROM sqlite_master WHERE type='table' AND name='direct_queries';
-- Check columns: PRAGMA table_info(direct_queries);
-- Verify indexes: SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='direct_queries';
-- Test query: SELECT * FROM direct_queries WHERE recipient_id = ? AND removed = FALSE ORDER BY sent_at DESC;

-- Rollback (if needed):
-- DROP INDEX IF EXISTS idx_direct_queries_recipient_status;
-- DROP INDEX IF EXISTS idx_direct_queries_sent_at;
-- DROP INDEX IF EXISTS idx_direct_queries_answered;
-- DROP INDEX IF EXISTS idx_direct_queries_payment_status;
-- DROP INDEX IF EXISTS idx_direct_queries_query;
-- DROP INDEX IF EXISTS idx_direct_queries_recipient;
-- DROP INDEX IF EXISTS idx_direct_queries_sender;
-- DROP TABLE IF EXISTS direct_queries;

