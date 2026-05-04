-- Migration: Add forked_from to question_meta
-- Date: 2026-05-04
-- Purpose: Track explicit fork lineage between questions (distinct from
-- canonical_id, which groups stem-equivalent variants discovered by the
-- reconciler). A fork is a deliberate re-ask with a different answer shape
-- (type or options/scale) — same intent, different response surface.

ALTER TABLE question_meta ADD COLUMN forked_from TEXT;

CREATE INDEX IF NOT EXISTS idx_qmeta_forked_from
  ON question_meta(forked_from) WHERE forked_from IS NOT NULL;
