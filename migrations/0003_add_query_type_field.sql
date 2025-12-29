-- Migration number: 0003 	 2025-12-27T00:00:00.000Z
-- Purpose: Add taxonomy fields to support Question Taxonomy (Identity/Temporal classification)
-- Related: docs/question-taxonomy.md
-- Note: query_type field was removed in migration 0004 - use taxonomy.primary_type instead

-- Add query_type column to queries table (DEPRECATED - removed in 0004)
ALTER TABLE queries ADD COLUMN query_type TEXT DEFAULT 'identity';

-- Add taxonomy metadata column (JSON) for extended classification
ALTER TABLE queries ADD COLUMN taxonomy TEXT DEFAULT NULL;

-- Create index for query_type lookups (DEPRECATED - removed in 0004)
CREATE INDEX IF NOT EXISTS idx_queries_query_type ON queries(query_type);

-- Migration validation queries:
-- Verify columns were added: SELECT query_type, taxonomy FROM queries LIMIT 1;
-- Check default value: SELECT query_type FROM queries WHERE query_type IS NULL;
-- Verify index: SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='queries';

-- Note: After migration 0004, only taxonomy field remains
-- Access primary_type via: JSON_EXTRACT(taxonomy, '$.primary_type')

-- Rollback (if needed):
-- DROP INDEX IF EXISTS idx_queries_query_type;
-- ALTER TABLE queries DROP COLUMN taxonomy;
-- ALTER TABLE queries DROP COLUMN query_type;

