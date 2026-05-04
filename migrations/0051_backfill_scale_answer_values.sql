-- Migration 0051: Backfill scale answer values to raw numerics
--
-- Scale answers (answer_type_id = 3) are now stored with the raw slider value
-- in Answers.value (e.g. "15"); human-readable labels are computed at render
-- time from the question's scale_config.
--
-- Historically the web client stored a label string in Answers.value
-- (e.g. "Mostly Yes" or the buggy "0 (15)" produced by getScaleLabel's
-- fallback). This migration recovers the raw numeric where possible.
--
-- Recovery strategy, per scale row:
--   1. If answer_data.index is set, use it (web submissions saved this).
--   2. Else if value matches a "...(N)" pattern, extract N (legacy fallback).
--   3. Else (e.g. "Mostly Yes" with no answer_data) leave as-is — unrecoverable
--      from SQL alone.

-- Note: answer_type_id is TEXT in the schema; values seen in the wild
-- include "3" and "3.0" depending on insertion path. Compare numerically.

-- Pass 1: prefer answer_data.index when present
UPDATE Answers
SET value = CAST(json_extract(answer_data, '$.index') AS TEXT)
WHERE CAST(answer_type_id AS REAL) = 3
  AND answer_data IS NOT NULL
  AND json_valid(answer_data)
  AND json_extract(answer_data, '$.index') IS NOT NULL;

-- Pass 2: extract trailing "(N)" from legacy fallback strings like "0 (15)"
-- Skip rows that already parse cleanly (snap-submitted) by requiring parens.
UPDATE Answers
SET value = SUBSTR(
  value,
  INSTR(value, '(') + 1,
  INSTR(value, ')') - INSTR(value, '(') - 1
)
WHERE CAST(answer_type_id AS REAL) = 3
  AND value LIKE '%(%)%'
  AND INSTR(value, ')') > INSTR(value, '(') + 1;
