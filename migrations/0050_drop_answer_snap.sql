-- Migration 0050: Migrate answer_snap data to Answers + answer_meta, then drop
-- Phase 2: Unified answer storage — all MC answers now live in Answers table
--
-- Steps:
--   1. Migrate existing answer_snap rows to Answers + answer_meta
--   2. Drop answer_snap table and its indexes

-- Step 1: Migrate answer_snap → Answers + answer_meta
-- Resolve option_index to label via json_each on queries.a_options
INSERT INTO Answers (id, q_id, user_id, value, answer_type_id, audience, created_at)
SELECT
  hex(randomblob(16)) AS id,
  as2.question_id,
  as2.fid,              -- fid IS user_id after migration 0049
  opt.value,            -- option label from a_options
  2,                    -- answer_type_id = mc
  'Public',
  as2.created_at
FROM answer_snap as2
JOIN queries q ON q.id = as2.question_id
JOIN json_each(q.a_options) opt ON opt.key = as2.option_index;

-- Insert corresponding answer_meta rows
INSERT INTO answer_meta (id, question_id, responder_fid, privacy_tier, primary_value, pending, created_at)
SELECT
  a.id,
  a.q_id,
  a.user_id,            -- responder_fid = user_id = fid
  'public',
  a.value,
  0,
  a.created_at
FROM Answers a
WHERE a.answer_type_id = 2
  AND a.audience = 'Public'
  AND a.id NOT IN (SELECT id FROM answer_meta);

-- Update pub_answers counts for affected questions
UPDATE queries SET pub_answers = (
  SELECT COUNT(*) FROM Answers WHERE q_id = queries.id AND audience = 'Public'
);

-- Step 2: Drop answer_snap table and indexes
DROP TABLE IF EXISTS answer_snap;
DROP INDEX IF EXISTS idx_answer_snap_question;
DROP INDEX IF EXISTS idx_answer_snap_session;
