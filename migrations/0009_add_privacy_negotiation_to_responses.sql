-- Migration number: 0009 	 2025-12-27T00:00:00.000Z
-- Purpose: Add privacy negotiation fields to direct_query_responses table
-- Related: docs/direct-queries-plan.md

-- Add privacy negotiation fields to direct_query_responses table
ALTER TABLE direct_query_responses ADD COLUMN proposed_audience TEXT; -- For privacy negotiation
ALTER TABLE direct_query_responses ADD COLUMN proposed_allowlist TEXT; -- JSON array of FIDs if proposing Allowlist

-- Update status enum to include 'privacy_negotiated'
-- Note: SQLite doesn't enforce enums, but we document the valid values:
-- 'accepted', 'rejected', 'counter_offered', 'privacy_negotiated'

-- Migration validation queries:
-- Verify columns: PRAGMA table_info(direct_query_responses);
-- Check new fields: SELECT proposed_audience, proposed_allowlist FROM direct_query_responses LIMIT 1;

-- Rollback (if needed):
-- ALTER TABLE direct_query_responses DROP COLUMN proposed_allowlist;
-- ALTER TABLE direct_query_responses DROP COLUMN proposed_audience;

