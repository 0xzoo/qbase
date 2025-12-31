-- Create user_signers table to persist Neynar signer UUIDs
-- This allows users to maintain their signers across sessions

CREATE TABLE IF NOT EXISTS user_signers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fid INTEGER NOT NULL,
  signer_uuid TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_approval', -- 'pending_approval', 'approved', 'revoked'
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (fid) REFERENCES users(fid)
);

-- Index for fast lookup by FID
CREATE INDEX IF NOT EXISTS idx_user_signers_fid ON user_signers(fid);

-- Index for fast lookup by UUID
CREATE INDEX IF NOT EXISTS idx_user_signers_uuid ON user_signers(signer_uuid);

-- Index for finding active signers
CREATE INDEX IF NOT EXISTS idx_user_signers_status ON user_signers(fid, status);

