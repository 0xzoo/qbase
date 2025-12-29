-- Migration number: 0004 	 2025-12-27T00:00:00.000Z
-- Purpose: Remove redundant query_type field in favor of taxonomy.primary_type
-- Related: docs/question-taxonomy.md
-- Reason: Consolidate to single source of truth - taxonomy JSON field is more extensible

-- IMPORTANT: Drop index BEFORE dropping column (SQLite requirement)
DROP INDEX IF EXISTS idx_queries_query_type;

-- Now drop the redundant query_type column
ALTER TABLE queries DROP COLUMN query_type;

-- Note: The taxonomy JSON field already contains primary_type
-- Access via: JSON_EXTRACT(taxonomy, '$.primary_type')
-- Can create functional index if needed:
-- CREATE INDEX IF NOT EXISTS idx_queries_taxonomy_primary_type ON queries(JSON_EXTRACT(taxonomy, '$.primary_type'));

-- Migration validation queries:
-- Verify column was removed: PRAGMA table_info(queries);
-- Check taxonomy field exists: SELECT taxonomy FROM queries LIMIT 1;
-- Test primary_type extraction: SELECT JSON_EXTRACT(taxonomy, '$.primary_type') FROM queries LIMIT 5;

-- Rollback (if needed):
-- ALTER TABLE queries ADD COLUMN query_type TEXT DEFAULT 'identity';
-- CREATE INDEX IF NOT EXISTS idx_queries_query_type ON queries(query_type);

