-- Migration: Create Answers table for public answers
-- Date: 2024-12-31
-- Purpose: Store public answers in D1 for efficient querying and listing

CREATE TABLE IF NOT EXISTS Answers (
  id TEXT PRIMARY KEY,
  q_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  value TEXT NOT NULL,           -- String or JSON object
  answer_type_id TEXT NOT NULL,  -- 'text', 'number', 'multiple_choice', 'boolean', 'scale'
  audience TEXT NOT NULL,        -- 'Public' only (Private/Anon/Allowlist stored in Nillion)
  created_at TEXT NOT NULL,      -- ISO 8601 timestamp
  FOREIGN KEY (q_id) REFERENCES queries(id),
  FOREIGN KEY (user_id) REFERENCES Users(id)
);

-- Index for query-based lookups (list all answers for a query)
CREATE INDEX IF NOT EXISTS idx_answers_query ON Answers(q_id, created_at DESC);

-- Index for user-based lookups (list all answers by a user)
CREATE INDEX IF NOT EXISTS idx_answers_user ON Answers(user_id, created_at DESC);

-- Index for audience filtering
CREATE INDEX IF NOT EXISTS idx_answers_audience ON Answers(audience);

