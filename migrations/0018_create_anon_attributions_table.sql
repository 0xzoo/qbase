-- Migration: Create anon_attributions table for anonymous content ownership
-- Date: 2025-01-02
-- Purpose: Store anonymous content attribution in D1 temporarily
-- This supports the temporary D1-only mode while Nillion integration is migrated

CREATE TABLE IF NOT EXISTS anon_attributions (
  id TEXT PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,  -- The public ID of the anonymous content (question/answer)
  author_id INTEGER NOT NULL,      -- The real author's internal user ID (kept private)
  type TEXT NOT NULL,              -- 'question' or 'answer'
  created_at TEXT NOT NULL,        -- ISO 8601 timestamp
  FOREIGN KEY (author_id) REFERENCES Users(id)
);

-- Index for looking up attribution by public_id
CREATE INDEX IF NOT EXISTS idx_anon_attributions_public_id ON anon_attributions(public_id);

-- Index for looking up user's anonymous content
CREATE INDEX IF NOT EXISTS idx_anon_attributions_author ON anon_attributions(author_id, type);

