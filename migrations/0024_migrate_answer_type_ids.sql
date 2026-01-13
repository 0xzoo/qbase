-- Migration: Migrate answer_type_id from string to integer and restructure value as JSON
-- Date: 2026-01-13
-- Purpose: Convert existing string answer_type_id values to integer foreign keys
--          and restructure value field as JSON
-- 
-- IMPORTANT: This is a breaking change. Run this AFTER creating new Nillion collections.
--
-- NOTE: The original schema never had q_index, so MC answers only have text values.
-- Index information will only be stored for NEW answers going forward.

-- Step 1: Add new integer columns
ALTER TABLE Answers ADD COLUMN answer_type_id_new INTEGER;
ALTER TABLE Answers ADD COLUMN suggested_answer_type_id_new INTEGER;
ALTER TABLE Answers ADD COLUMN value_new TEXT;

-- Step 2: Migrate answer_type_id string -> integer
UPDATE Answers SET answer_type_id_new = CASE
  WHEN answer_type_id = 'text' THEN 1
  WHEN answer_type_id = 'mc' THEN 2
  WHEN answer_type_id = 'multiple_choice' THEN 2
  WHEN answer_type_id = 'scale' THEN 3
  WHEN answer_type_id = 'number' THEN 3
  WHEN answer_type_id = 'boolean' THEN 1
  ELSE 1 -- Default to text
END;

-- Step 3: Migrate suggested_answer_type_id (copy from answer_type_id_new)
UPDATE Answers SET suggested_answer_type_id_new = answer_type_id_new;

-- Step 4: Restructure value field as JSON based on type
-- Text answers: {"text": "original value"}
UPDATE Answers 
SET value_new = json_object('text', value)
WHERE answer_type_id_new = 1;

-- MC answers: {"text": "option text"} 
-- NOTE: No index available for existing answers (q_index was never stored)
-- New answers will include index going forward
UPDATE Answers 
SET value_new = json_object('text', value)
WHERE answer_type_id_new = 2;

-- Scale answers: {"value": numeric_value}
UPDATE Answers 
SET value_new = json_object('value', CAST(value AS INTEGER))
WHERE answer_type_id_new = 3;

-- Fallback for any missed rows
UPDATE Answers 
SET value_new = json_object('text', value)
WHERE value_new IS NULL;

-- Step 5: Create indexes on new columns
CREATE INDEX IF NOT EXISTS idx_answers_type_new ON Answers(answer_type_id_new);

-- ============================================================================
-- MANUAL STEPS - Run these after verifying the migration
-- ============================================================================
-- 
-- Verify the migration worked:
-- SELECT 
--   answer_type_id, 
--   answer_type_id_new, 
--   value,
--   value_new,
--   COUNT(*) 
-- FROM Answers 
-- GROUP BY answer_type_id, answer_type_id_new
-- LIMIT 100;
--
-- Then run these commands to finalize:
--
-- -- Drop old columns (SQLite 3.35.0+ supports DROP COLUMN)
-- ALTER TABLE Answers DROP COLUMN answer_type_id;
-- ALTER TABLE Answers DROP COLUMN value;
--
-- -- Rename new columns
-- ALTER TABLE Answers RENAME COLUMN answer_type_id_new TO answer_type_id;
-- ALTER TABLE Answers RENAME COLUMN suggested_answer_type_id_new TO suggested_answer_type_id;
-- ALTER TABLE Answers RENAME COLUMN value_new TO value;
--
-- -- Update index
-- DROP INDEX IF EXISTS idx_answers_type_new;
-- CREATE INDEX IF NOT EXISTS idx_answers_type ON Answers(answer_type_id);
