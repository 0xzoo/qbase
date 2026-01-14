-- Add Farcaster Pro subscription status to users table
-- Synced from Neynar on login, used to determine cast length limits
-- 
-- pro_status values: 'subscribed', 'unsubscribed', or NULL (unknown/never checked)
-- pro_expires_at: ISO 8601 datetime string

ALTER TABLE users ADD COLUMN pro_status TEXT DEFAULT NULL;
ALTER TABLE users ADD COLUMN pro_expires_at TEXT DEFAULT NULL;
