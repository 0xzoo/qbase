-- Migration: Create answer_types lookup table
-- Date: 2026-01-13
-- Purpose: Normalize answer types into a table for future extensibility
-- This allows adding new question types without schema changes

-- Create answer_types lookup table
CREATE TABLE IF NOT EXISTS answer_types (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  json_schema TEXT NOT NULL, -- JSON describing the expected value structure
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Populate with answer types
-- IDs are explicit to ensure consistency across environments
INSERT INTO answer_types (id, name, description, json_schema) VALUES
  (1, 'text', 'Free-form text response', '{"text": "string"}'),
  (2, 'mc', 'Multiple choice - select one', '{"text": "string", "index": "number"}'),
  (3, 'scale', 'Numeric scale rating', '{"value": "number"}'),
  (4, 'checkbox', 'Multiple choice - select many', '{"text": "string", "indices": "number[]"}');

-- Index for name lookups
CREATE INDEX IF NOT EXISTS idx_answer_types_name ON answer_types(name);
