-- Migration number: 0029    2026-03-18T00:00:00.000Z
-- Purpose: Create passkey authentication tables for Quilibrium-based identity
-- Phase 1b: Store passkey registrations in D1, enable passkey sessions

-- ============================================================================
-- Table: passkey_users
-- Purpose: One row per Quilibrium address (passkey identity)
-- ============================================================================

CREATE TABLE IF NOT EXISTS passkey_users (
  address TEXT PRIMARY KEY,             -- Quilibrium address (Qm... base58btc)
  public_key TEXT NOT NULL,             -- Ed448 public key (hex)
  display_name TEXT,                    -- User-chosen display name
  created_at INTEGER NOT NULL,          -- Unix timestamp ms
  last_login_at INTEGER,                -- Unix timestamp ms
  fid INTEGER DEFAULT NULL,             -- Optional: linked Farcaster FID
  UNIQUE(public_key)
);

CREATE INDEX IF NOT EXISTS idx_passkey_users_fid 
  ON passkey_users(fid) WHERE fid IS NOT NULL;

-- ============================================================================
-- Table: passkey_registrations
-- Purpose: Store WebAuthn credential data (replaces localStorage)
-- A user can have multiple passkeys (e.g., phone + laptop)
-- ============================================================================

CREATE TABLE IF NOT EXISTS passkey_registrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  address TEXT NOT NULL,                -- FK to passkey_users.address
  credential_id TEXT NOT NULL,          -- WebAuthn credential ID (base64)
  registration_data TEXT NOT NULL,      -- JSON blob from Quilibrium SDK
  device_name TEXT,                     -- Optional: "MacBook Pro", "iPhone"
  created_at INTEGER NOT NULL,          -- Unix timestamp ms
  last_used_at INTEGER,                 -- Unix timestamp ms
  FOREIGN KEY (address) REFERENCES passkey_users(address) ON DELETE CASCADE,
  UNIQUE(credential_id)
);

CREATE INDEX IF NOT EXISTS idx_passkey_registrations_address 
  ON passkey_registrations(address);

-- ============================================================================
-- Rollback (if needed):
-- ============================================================================
-- DROP INDEX IF EXISTS idx_passkey_registrations_address;
-- DROP TABLE IF EXISTS passkey_registrations;
-- DROP INDEX IF EXISTS idx_passkey_users_fid;
-- DROP TABLE IF EXISTS passkey_users;
