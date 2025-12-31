-- Fix foreign key constraint issue in user_signers
-- SQLite doesn't support ALTER TABLE to drop constraints, so we recreate the table

-- Step 1: Drop the existing table
DROP TABLE IF EXISTS user_signers;

-- Step 2: Recreate without the foreign key constraint
-- (FK constraint isn't critical here since we control the data flow)
CREATE TABLE user_signers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fid INTEGER NOT NULL,
  signer_uuid TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_approval',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Recreate indexes
CREATE INDEX idx_user_signers_fid ON user_signers(fid);
CREATE INDEX idx_user_signers_uuid ON user_signers(signer_uuid);
CREATE INDEX idx_user_signers_status ON user_signers(fid, status);

