-- Migration number: 0008 	 2025-12-27T00:00:00.000Z
-- Purpose: Add answer privacy/audience fields to direct_queries table
-- Related: docs/direct-queries-plan.md

-- Add privacy/audience fields to direct_queries table
ALTER TABLE direct_queries ADD COLUMN requested_audience TEXT DEFAULT 'Public';
ALTER TABLE direct_queries ADD COLUMN requested_allowlist TEXT; -- JSON array of FIDs
ALTER TABLE direct_queries ADD COLUMN agreed_audience TEXT; -- Set when recipient accepts
ALTER TABLE direct_queries ADD COLUMN agreed_allowlist TEXT; -- JSON array of FIDs if Allowlist
ALTER TABLE direct_queries ADD COLUMN actual_audience TEXT; -- Actual privacy tier used in answer

-- Add index for filtering by requested privacy tier
CREATE INDEX IF NOT EXISTS idx_direct_queries_requested_audience 
ON direct_queries(requested_audience);

-- Migration validation queries:
-- Verify columns: PRAGMA table_info(direct_queries);
-- Check default: SELECT requested_audience FROM direct_queries LIMIT 1;
-- Verify index: SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='direct_queries' AND name LIKE '%audience%';

-- Rollback (if needed):
-- DROP INDEX IF EXISTS idx_direct_queries_requested_audience;
-- ALTER TABLE direct_queries DROP COLUMN actual_audience;
-- ALTER TABLE direct_queries DROP COLUMN agreed_allowlist;
-- ALTER TABLE direct_queries DROP COLUMN agreed_audience;
-- ALTER TABLE direct_queries DROP COLUMN requested_allowlist;
-- ALTER TABLE direct_queries DROP COLUMN requested_audience;

