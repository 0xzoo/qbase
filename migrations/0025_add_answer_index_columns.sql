-- Migration: Add answer_data column to Answers table
-- Date: 2026-01-13
-- Purpose: Store type-specific structured data (indices, ranges, etc.) separate from display value
--
-- The `value` field contains human-readable display text.
-- The `answer_data` field contains JSON with type-specific structured data:
--   - MC: {"index": 1}
--   - Checkbox: {"indices": [0, 2, 4]}
--   - Ranking: {"indices": [2, 0, 1, 3]}  (future)
--   - Range: {"min": 3, "max": 7}  (future)
--   - etc.

ALTER TABLE Answers ADD COLUMN answer_data TEXT;
