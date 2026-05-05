-- Migration: Normalize Answers.created_at to ISO 8601
-- Date: 2026-05-05
-- Purpose: The Answers.created_at column is declared TEXT NOT NULL and was
--   intended to hold ISO 8601 timestamps (per migration 0014). The miniapp
--   path (worker/handlers/answers/create.ts) writes ISO strings, but the snap
--   path (worker/routes/snap.ts) was writing Date.now() ms values. Both ended
--   up stored as TEXT due to column affinity, leaving mixed formats:
--     ISO:  "2026-05-05T19:30:59.526Z"  (28 rows pre-migration)
--     ms:   "1778009190433"             (214 rows pre-migration)
--   This causes lexicographic ORDER BY DESC to misorder rows across formats
--   in some edge cases. The snap path is fixed at the source in this same
--   change; this migration converts the existing ms-format rows.
--
-- Uses SQLite's strftime to produce JS-toISOString-compatible output
-- ("YYYY-MM-DDTHH:MM:SS.SSSZ"). The WHERE clause matches purely-numeric
-- strings only — ISO strings contain hyphens and are skipped.

UPDATE Answers
SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', CAST(created_at AS INTEGER) / 1000.0, 'unixepoch')
WHERE created_at NOT LIKE '%-%'
  AND created_at GLOB '[0-9]*';
