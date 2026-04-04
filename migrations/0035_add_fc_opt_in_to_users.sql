-- Migration number: 0035   2026-04-04
-- Purpose: Add fc_opt_in column to Users table
-- Controls whether the user's answers/actions are syndicated to Farcaster.
-- Default: TRUE for existing FC users (grandfathered), FALSE for new users.
-- New users must explicitly opt-in to FC syndication.

ALTER TABLE Users ADD COLUMN fc_opt_in INTEGER DEFAULT 0;

-- Set fc_opt_in = 1 for existing users who have a non-null FID (they were already on FC)
UPDATE Users SET fc_opt_in = 1 WHERE fid IS NOT NULL;
