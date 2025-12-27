-- Migration number: 0003 	 2025-12-27T00:00:00.000Z
-- Purpose: Add query_type field to support Question Taxonomy (Identity/Temporal/Template classification)
-- Related: docs/question-taxonomy.md

-- Add query_type column to queries table
ALTER TABLE queries ADD COLUMN query_type TEXT DEFAULT 'identity';

-- Add taxonomy metadata column (JSON) for extended classification
ALTER TABLE queries ADD COLUMN taxonomy TEXT DEFAULT NULL;

-- Create index for query_type lookups (frequently filtered in answer retrieval)
CREATE INDEX IF NOT EXISTS idx_queries_query_type ON queries(query_type);

-- Migration validation queries:
-- Verify column was added: SELECT query_type FROM queries LIMIT 1;
-- Check default value: SELECT query_type FROM queries WHERE query_type IS NULL;
-- Verify index: SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='queries';

-- Rollback (if needed):
-- DROP INDEX IF EXISTS idx_queries_query_type;
-- ALTER TABLE queries DROP COLUMN taxonomy;
-- ALTER TABLE queries DROP COLUMN query_type;

