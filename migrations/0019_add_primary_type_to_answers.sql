-- Migration: Add primary_type column to Answers table
-- Date: 2026-01-03
-- Purpose: Support knowledge questions using existing table (minimal approach)

-- Add primary_type column with default 'identity' for backwards compatibility
ALTER TABLE Answers ADD COLUMN primary_type TEXT DEFAULT 'identity';

-- Add index for filtering by primary_type
CREATE INDEX IF NOT EXISTS idx_answers_primary_type ON Answers(primary_type);

-- Optional: Add knowledge-specific fields (nullable)
ALTER TABLE Answers ADD COLUMN reasoning TEXT;
ALTER TABLE Answers ADD COLUMN topics TEXT;  -- JSON array as string

