-- Migration number: 0065 	2026-09-07T00:00:00.000Z
-- Purpose: Reopen questions that 0064 backfilled into waves.
--   0064 mirrored each backfilled wave's closes_at onto the legacy
--   queries.closes_at so the question-scoped enforcement path would still
--   lock the poll. Enforcement is now wave-scoped (EligibilityService reads
--   `polls`; Track A1, t_83271038), so the mirror is dead for enforcement and
--   only makes the *question* look closed to the client. Clear it: a question
--   is always answerable — gates live on waves only.
--   Idempotent. queries.closes_at / eligibility_gate are dropped in Track A6.
-- Related: docs/specs/question-wave-attribution.md, docs/plans/wave-governance-roadmap.md

UPDATE queries
SET closes_at = NULL
WHERE closes_at IS NOT NULL
  AND id IN (SELECT question_id FROM polls);

-- Rollback (if needed):
-- UPDATE queries SET closes_at = (
--   SELECT p.closes_at FROM polls p WHERE p.question_id = queries.id ORDER BY p.created_at LIMIT 1
-- ) WHERE closes_at IS NULL AND id IN (SELECT question_id FROM polls);
