-- cast_stats_cache + feed_entries: denormalized hot-path cache.
-- See docs/hypersnap/data-layer.md § Layer 2: Denormalized Hot-Path Cache.
--
-- Both tables are rebuildable from Hypersnap at any time — if an entry is
-- missing, treat as zero and let the next webhook correct it.
--
-- cast_stats_cache: engagement counts for quick feed rendering.
-- feed_entries: materialized feed entries per topic, scored for ranking.

CREATE TABLE IF NOT EXISTS cast_stats_cache (
  cast_hash     TEXT PRIMARY KEY,
  reply_count   INTEGER DEFAULT 0,
  like_count    INTEGER DEFAULT 0,
  recast_count  INTEGER DEFAULT 0,
  last_reply_at INTEGER,
  refreshed_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS feed_entries (
  topic_id     TEXT NOT NULL,
  cast_hash    TEXT NOT NULL,
  author_fid   INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  score        REAL NOT NULL,
  PRIMARY KEY (topic_id, cast_hash)
);

CREATE INDEX IF NOT EXISTS idx_feed_topic_score
  ON feed_entries(topic_id, score DESC);
CREATE INDEX IF NOT EXISTS idx_feed_topic_time
  ON feed_entries(topic_id, created_at DESC);

-- canonical_merge_log: records when two canonical IDs are merged.
-- Used by the reconciler's canonical dedup race detection.
-- See docs/hypersnap/data-layer.md § Canonical dedup race.

CREATE TABLE IF NOT EXISTS canonical_merge_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kept_canonical  TEXT NOT NULL,
  merged_canonical TEXT NOT NULL,
  merged_at       INTEGER NOT NULL
);
