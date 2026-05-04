-- Migration 0052: Restore indexes dropped by 0049 table rebuilds
-- Date: 2026-05-03
--
-- Migration 0049 rebuilt the Answers and anon_attributions tables to drop the
-- FK to Users (after fid became the PK there). The rebuild only re-created
-- idx_answers_user_id; the rest of the original indexes from 0014, 0018, 0019,
-- and 0024 were silently lost.
--
-- Restore them so list-answers and analytics queries stop full-scanning.
-- All statements are idempotent (CREATE INDEX IF NOT EXISTS).
--
-- Notes:
-- - anon_attributions.public_id has a UNIQUE constraint in the rebuilt table,
--   which SQLite backs with an auto-generated index — no explicit index needed.
-- - idx_answers_user_id (added by 0049) is a strict subset of idx_answers_user
--   below; drop it to avoid double-writing on every insert.
-- - 0024's idx_answers_type_new is intentionally not restored: no live query
--   reads the answer_type_id_new column (all callers use answer_type_id).

CREATE INDEX IF NOT EXISTS idx_answers_query ON Answers(q_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_answers_user ON Answers(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_answers_audience ON Answers(audience);
CREATE INDEX IF NOT EXISTS idx_answers_primary_type ON Answers(primary_type);
CREATE INDEX IF NOT EXISTS idx_anon_attributions_author ON anon_attributions(author_id, type);

DROP INDEX IF EXISTS idx_answers_user_id;
