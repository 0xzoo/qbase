-- Migration number: 0033   2026-04-04
-- Purpose: Create qbase-native follows table using user identity (quil_address or FID)
-- This is the native social graph, independent of Farcaster.

CREATE TABLE IF NOT EXISTS follows (
  follower_id TEXT NOT NULL,
  followee_id TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000),
  PRIMARY KEY (follower_id, followee_id)
);

CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows(follower_id);
CREATE INDEX IF NOT EXISTS idx_follows_followee ON follows(followee_id);

-- Port existing FC-based follows from qbase_follows to the native follows table.
-- Only port if both parties have quil_address (passkey users).
-- Miniapp-only users (FID only, no passkey) will be ported when they first set up passkeys.
INSERT OR IGNORE INTO follows (follower_id, followee_id, created_at)
SELECT
  u_f.quil_address,
  u_e.quil_address,
  CAST(strftime('%s', qf.created_at) AS INTEGER) * 1000
FROM qbase_follows qf
JOIN Users u_f ON u_f.fid = qf.follower_fid AND u_f.quil_address IS NOT NULL
JOIN Users u_e ON u_e.fid = qf.following_fid AND u_e.quil_address IS NOT NULL;
