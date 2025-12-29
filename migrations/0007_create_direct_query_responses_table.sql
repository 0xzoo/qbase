-- Migration number: 0007 	 2025-12-27T00:00:00.000Z
-- Purpose: Create direct_query_responses table for accept/decline/counter-offer flow
-- Related: docs/TODO.md (Direct Queries Payment System), FEATURES.md

-- Direct query responses table for recipient accept/decline/counter-offer actions
CREATE TABLE IF NOT EXISTS direct_query_responses (
  id TEXT PRIMARY KEY,
  direct_q_id TEXT NOT NULL,
  recipient_id INTEGER NOT NULL,
  status TEXT NOT NULL, -- 'accepted', 'rejected', 'counter_offered'
  counter_amount INTEGER, -- New amount if status is 'counter_offered'
  reason TEXT, -- Optional reason for rejection or counter-offer
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (direct_q_id) REFERENCES direct_queries(id) ON DELETE CASCADE
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_direct_query_responses_direct_q ON direct_query_responses(direct_q_id);
CREATE INDEX IF NOT EXISTS idx_direct_query_responses_recipient ON direct_query_responses(recipient_id);
CREATE INDEX IF NOT EXISTS idx_direct_query_responses_status ON direct_query_responses(status);
CREATE INDEX IF NOT EXISTS idx_direct_query_responses_created_at ON direct_query_responses(created_at);
-- Composite index for finding latest response per direct query
CREATE INDEX IF NOT EXISTS idx_direct_query_responses_latest 
ON direct_query_responses(direct_q_id, created_at DESC);

-- Migration validation queries:
-- Verify table: SELECT name FROM sqlite_master WHERE type='table' AND name='direct_query_responses';
-- Check columns: PRAGMA table_info(direct_query_responses);
-- Verify indexes: SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='direct_query_responses';
-- Test query: SELECT * FROM direct_query_responses WHERE direct_q_id = ? ORDER BY created_at DESC LIMIT 1;

-- Rollback (if needed):
-- DROP INDEX IF EXISTS idx_direct_query_responses_latest;
-- DROP INDEX IF EXISTS idx_direct_query_responses_created_at;
-- DROP INDEX IF EXISTS idx_direct_query_responses_status;
-- DROP INDEX IF EXISTS idx_direct_query_responses_recipient;
-- DROP INDEX IF EXISTS idx_direct_query_responses_direct_q;
-- DROP TABLE IF EXISTS direct_query_responses;

