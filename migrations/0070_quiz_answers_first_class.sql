-- Migration number: 0070 	2026-09-07T21:00:00.000Z
-- Purpose: quiz answers become first-class Answers rows
--   (docs/quizzes/CONTENT-PLAN.md §6 V1, card t_b544c849). The completion
--   writer now materialises one Answers row per quiz item — audience
--   'Private', content sealed in Q Storage, D1 carrying '[encrypted]' — so a
--   quiz answer has an id, an audience and the same re-scope path as every
--   canonical answer. Two columns carry the link and the bookkeeping:
--
--   * Answers.quiz_completion_id — the completion a row came from (NULL for
--     every in-feed answer). Groups a quiz's rows for the /me/answers surface
--     (V2) without opening anything.
--   * quiz_completions.answers_materialized_at — set once the completion's
--     rows are written. NULL means "not yet": the backfill's selector and the
--     retry marker for a live write that failed.
--
--   Additive only; no data moves here. Past completions get their rows from
--   POST /api/admin/quiz-answers-backfill.

ALTER TABLE Answers ADD COLUMN quiz_completion_id TEXT;
CREATE INDEX IF NOT EXISTS idx_answers_quiz_completion
  ON Answers(quiz_completion_id)
  WHERE quiz_completion_id IS NOT NULL;

ALTER TABLE quiz_completions ADD COLUMN answers_materialized_at TEXT;

-- Rollback:
-- DROP INDEX IF EXISTS idx_answers_quiz_completion;
-- ALTER TABLE Answers DROP COLUMN quiz_completion_id;
-- ALTER TABLE quiz_completions DROP COLUMN answers_materialized_at;
