-- Migration: Normalize Answers.answer_type_id to canonical integer-as-string
-- Date: 2026-05-05
-- Purpose: Answers.answer_type_id is declared TEXT NOT NULL (FK to answer_types
--   by integer id: 1=text, 2=mc, 3=scale, 4=checkbox). The snap path writes
--   integer literals in SQL ("INSERT ... VALUES (..., 2, ...)") which SQLite
--   stores as the text "2". The miniapp path binds JS numbers, which D1
--   sends as REAL — SQLite's TEXT affinity then converts those to "2.0",
--   "1.0", "3.0" etc. Result: 28 rows pre-migration with ".0" suffixes that
--   silently fail equality with the canonical "2"/"3"/etc. used by every
--   read filter (e.g. WHERE answer_type_id = 2 in getMcCounts), so those
--   answers were excluded from result tallies.
--
-- Source fix in this same change: bind String(body.answer_type_id) in the
--   create/mutate handlers so D1 stores plain text directly.
-- Backfill: strip the trailing ".0" via INTEGER round-trip cast.

UPDATE Answers
SET answer_type_id = CAST(CAST(answer_type_id AS INTEGER) AS TEXT)
WHERE answer_type_id LIKE '%.%';
