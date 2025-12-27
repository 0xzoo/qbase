-- Migration: Create temporary_answers table for tourist/casual participation
-- Date: 2024-12-20
-- Purpose: Separate lightweight survey responses from permanent profile data

CREATE TABLE IF NOT EXISTS temporary_answers (
  id TEXT PRIMARY KEY,
  q_id TEXT NOT NULL,
  user_session TEXT,             -- Session/device ID for tourists without accounts
  user_id INTEGER,               -- NULL if no account yet, set when they sign up
  value TEXT NOT NULL,           -- String or JSON object
  answer_type_id TEXT NOT NULL,
  q_index INTEGER,               -- Index for MC/scale answers
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,   -- Auto-delete timestamp (30 days from creation)
  FOREIGN KEY (q_id) REFERENCES queries(id)
);

-- Index for cleanup job (delete expired answers)
CREATE INDEX IF NOT EXISTS idx_temporary_answers_expires ON temporary_answers(expires_at);

-- Index for session-based lookups (tourist claims their answers)
CREATE INDEX IF NOT EXISTS idx_temporary_answers_session ON temporary_answers(user_session);

-- Index for user-based lookups (show user their temporary answers)
CREATE INDEX IF NOT EXISTS idx_temporary_answers_user ON temporary_answers(user_id) WHERE user_id IS NOT NULL;

-- Index for query-based lookups (survey creator sees responses)
CREATE INDEX IF NOT EXISTS idx_temporary_answers_query ON temporary_answers(q_id);

