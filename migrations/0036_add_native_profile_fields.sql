-- Migration number: 0036    2026-04-04T00:00.000Z
-- Purpose: Add native profile fields to users table for FC-decoupled identity
-- Phase 1 of native identity system (see docs/plans/native-identity.md)

-- ============================================================================
-- Add native profile columns to users
-- All nullable for backward compatibility
-- ============================================================================

ALTER TABLE users ADD COLUMN username TEXT;
ALTER TABLE users ADD COLUMN display_name TEXT;
ALTER TABLE users ADD COLUMN pfp_url TEXT;
ALTER TABLE users ADD COLUMN bio TEXT;
ALTER TABLE users ADD COLUMN profile_source TEXT DEFAULT 'farcaster';

-- Unique index on username (partial - only non-null)
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username
  ON users(username) WHERE username IS NOT NULL;
