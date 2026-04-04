-- Migration number: 0034   2026-04-04
-- Purpose: Update answer_likes table to support quil_address identity
-- Replace user_fid with user_id TEXT (can be quil_address or stringified FID)

-- Add new column
ALTER TABLE answer_likes ADD COLUMN user_id TEXT;

-- Populate user_id from existing user_fid (stringified FID for current records)
UPDATE answer_likes SET user_id = CAST(user_fid AS TEXT) WHERE user_id IS NULL;

-- Create new unique constraint on answer_id + user_id
-- Note: Can't easily drop the old UNIQUE(answer_id, user_fid) in D1,
-- but we'll enforce the new one at the application level and use user_id for all new operations.
CREATE UNIQUE INDEX IF NOT EXISTS idx_answer_likes_answer_user ON answer_likes(answer_id, user_id);

-- Keep the old user_fid column for backwards compat during transition period.
-- Future migration can drop it once all codepaths use user_id.
