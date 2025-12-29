-- Migration number: 0005 	 2025-12-27T00:00:00.000Z
-- Purpose: Add indexes for taxonomy JSON field to enable efficient filtering
-- Related: docs/question-taxonomy.md

-- Create indexes for common taxonomy queries
-- SQLite supports JSON extraction in indexes

-- Index for primary_type (most common filter - identity vs temporal)
CREATE INDEX IF NOT EXISTS idx_queries_taxonomy_primary 
ON queries(json_extract(taxonomy, '$.primary_type'))
WHERE taxonomy IS NOT NULL;

-- Index for construction_type (template vs complete vs follow_up)
CREATE INDEX IF NOT EXISTS idx_queries_taxonomy_construction 
ON queries(json_extract(taxonomy, '$.construction_type'))
WHERE taxonomy IS NOT NULL;

-- Index for sensitivity level (privacy filtering)
CREATE INDEX IF NOT EXISTS idx_queries_taxonomy_sensitivity 
ON queries(json_extract(taxonomy, '$.sensitivity'))
WHERE taxonomy IS NOT NULL;

-- Composite index for primary_type + sensitivity (common research query pattern)
CREATE INDEX IF NOT EXISTS idx_queries_taxonomy_primary_sensitivity 
ON queries(
  json_extract(taxonomy, '$.primary_type'),
  json_extract(taxonomy, '$.sensitivity')
)
WHERE taxonomy IS NOT NULL;

-- Migration validation queries:
-- Verify indexes: SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='queries' AND name LIKE '%taxonomy%';
-- Test primary_type query: SELECT COUNT(*) FROM queries WHERE json_extract(taxonomy, '$.primary_type') = 'identity';
-- Test sensitivity query: SELECT COUNT(*) FROM queries WHERE json_extract(taxonomy, '$.sensitivity') = 'high';

-- Example queries enabled by these indexes:
-- 1. Find all identity questions: WHERE json_extract(taxonomy, '$.primary_type') = 'identity'
-- 2. Find all temporal questions: WHERE json_extract(taxonomy, '$.primary_type') = 'temporal'
-- 3. Find all template questions: WHERE json_extract(taxonomy, '$.construction_type') = 'template'
-- 4. Find high-sensitivity questions: WHERE json_extract(taxonomy, '$.sensitivity') = 'high'
-- 5. Find temporal + medium sensitivity: WHERE json_extract(taxonomy, '$.primary_type') = 'temporal' AND json_extract(taxonomy, '$.sensitivity') = 'medium'

