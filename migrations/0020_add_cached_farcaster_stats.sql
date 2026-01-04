-- Migration: Add cached Farcaster engagement stats to farcaster_casts
-- These columns store fresh counts from Farcaster API to avoid computing from local reactions only

ALTER TABLE farcaster_casts ADD COLUMN cached_likes_count INTEGER DEFAULT 0;
ALTER TABLE farcaster_casts ADD COLUMN cached_recasts_count INTEGER DEFAULT 0;
ALTER TABLE farcaster_casts ADD COLUMN cached_replies_count INTEGER DEFAULT 0;
ALTER TABLE farcaster_casts ADD COLUMN stats_synced_at INTEGER;

-- Rollback:
-- ALTER TABLE farcaster_casts DROP COLUMN cached_likes_count;
-- ALTER TABLE farcaster_casts DROP COLUMN cached_recasts_count;
-- ALTER TABLE farcaster_casts DROP COLUMN cached_replies_count;
-- ALTER TABLE farcaster_casts DROP COLUMN stats_synced_at;

