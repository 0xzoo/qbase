-- Migration number: 0066 	2026-09-07T01:00:00.000Z
-- Purpose: Wave kind + channel provenance (Track A2, t_cfdea6c7).
--   * polls.kind — 'measure' (unstaked, anon allowed; the default) or
--     'decide' (staked, delegable; built in Track D). Reserved now so the
--     column exists before any decide-wave code lands.
--   * polls.channel_id — the Farcaster channel the wave was opened into
--     (provenance alongside author_fid + cast_hash).
-- Related: docs/specs/question-wave-attribution.md (decisions 3, 4)

ALTER TABLE polls ADD COLUMN kind TEXT NOT NULL DEFAULT 'measure';
ALTER TABLE polls ADD COLUMN channel_id TEXT;

-- Rollback (if needed):
-- ALTER TABLE polls DROP COLUMN channel_id;
-- ALTER TABLE polls DROP COLUMN kind;
