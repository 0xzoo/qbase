-- Migration: Add allowlist_data column to Answers table
-- Date: 2025-01-02
-- Purpose: Store allowlist information for Allowlist answers in D1
-- This supports the temporary D1-only mode while Nillion integration is migrated

-- Add allowlist_data column (JSON string containing allowlist_id or allowlist array)
ALTER TABLE Answers ADD COLUMN allowlist_data TEXT;

-- Note: This column stores either:
-- - { "allowlist_id": "uuid" } for named allowlists
-- - { "allowlist": [fid1, fid2, ...] } for one-off allowlists

