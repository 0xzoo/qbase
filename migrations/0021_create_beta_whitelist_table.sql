-- Migration: Create beta_whitelist table for controlling access during beta
-- Temporary table to be removed after beta period

CREATE TABLE IF NOT EXISTS beta_whitelist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fid INTEGER NOT NULL UNIQUE,
  fname TEXT,  -- Optional: for display purposes
  added_by_fid INTEGER,  -- FID of admin who added this user
  added_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  notes TEXT  -- Optional notes about why they were added
);

-- Index for fast FID lookups
CREATE INDEX IF NOT EXISTS idx_beta_whitelist_fid ON beta_whitelist(fid);

-- Rollback:
-- DROP TABLE IF EXISTS beta_whitelist;

