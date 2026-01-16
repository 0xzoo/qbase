-- Migration number: 0028   2025-01-16
-- Purpose: Create answer_likes table for qbase-internal answer likes
-- Note: This is the single source of truth for answer likes. Farcaster sync is fire-and-forget.

-- ============================================================================
-- Table: answer_likes
-- Purpose: Track likes on answers within qbase (independent of Farcaster)
-- ============================================================================

CREATE TABLE IF NOT EXISTS answer_likes (
  id TEXT PRIMARY KEY,
  answer_id TEXT NOT NULL,
  user_fid INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  
  -- Note: We don't add FK to Answers table because some answers are stored in Nillion
  -- The answer_id can reference either D1 Answers or Nillion-stored answers
  UNIQUE(answer_id, user_fid)
);

-- Index for counting likes on an answer
CREATE INDEX IF NOT EXISTS idx_answer_likes_answer ON answer_likes(answer_id);

-- Index for finding all likes by a user
CREATE INDEX IF NOT EXISTS idx_answer_likes_user ON answer_likes(user_fid);

-- ============================================================================
-- Rollback (if needed):
-- ============================================================================
-- DROP INDEX IF EXISTS idx_answer_likes_user;
-- DROP INDEX IF EXISTS idx_answer_likes_answer;
-- DROP TABLE IF EXISTS answer_likes;
