-- Migration 0048: Add fid columns to Answers and anon_attributions
-- Phase 1 of fid-as-pk migration: add fid columns, backfill from Users, add indexes
-- D1 compatible: uses ALTER TABLE ADD COLUMN (supported), no DROP COLUMN

-- Step 1: Add fid column to Answers table
ALTER TABLE Answers ADD COLUMN fid INTEGER;

-- Step 2: Backfill Answers.fid from Users table
UPDATE Answers SET fid = (SELECT fid FROM Users WHERE Users.id = Answers.user_id);

-- Step 3: Index on Answers(fid) for lookup performance
CREATE INDEX IF NOT EXISTS idx_answers_fid ON Answers(fid);

-- Step 4: Add fid column to anon_attributions table
ALTER TABLE anon_attributions ADD COLUMN fid INTEGER;

-- Step 5: Backfill anon_attributions.fid from Users table
UPDATE anon_attributions SET fid = (SELECT fid FROM Users WHERE Users.id = anon_attributions.author_id);

-- Step 6: Index on anon_attributions(fid) for lookup performance
CREATE INDEX IF NOT EXISTS idx_anon_attributions_fid ON anon_attributions(fid);
