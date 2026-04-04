-- Migration number: 0032   2026-04-04
-- Purpose: Add quil_address to Users table
-- Quil DID-first identity: Users are identified by passkey (quil_address) primarily,
-- with optional Farcaster FID for miniapp and FC port.

-- Add quil_address column (maps to passkey_users.address from migration 0029)
ALTER TABLE Users ADD COLUMN quil_address TEXT;

-- Indexes for lookups
CREATE INDEX IF NOT EXISTS idx_users_quil_address ON Users(quil_address) WHERE quil_address IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_quil_unique ON Users(quil_address) WHERE quil_address IS NOT NULL;

-- Note: fid stays but is now nullable (not constrained NOT NULL by default when added via ALTER TABLE).
-- Existing FC users have fid. New passkey-only users have quil_address.
-- Linked users have both.

-- Populate quil_address for passkey users who already have an FC account
-- This bridges the gap: if a passkey address is linked to an existing FC FID, set it on the Users row
UPDATE Users SET quil_address = (
  SELECT address FROM passkey_users WHERE passkey_users.fid = Users.fid LIMIT 1
) WHERE Users.fid IS NOT NULL AND Users.fid IN (
  SELECT fid FROM passkey_users WHERE fid IS NOT NULL
);
