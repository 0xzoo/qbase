-- Add channel_id column to queries table for Farcaster channel posting
-- This allows questions to be posted to specific Farcaster channels

ALTER TABLE queries ADD COLUMN channel_id TEXT;

-- Create index for channel-based queries
CREATE INDEX IF NOT EXISTS idx_queries_channel_id ON queries(channel_id);
