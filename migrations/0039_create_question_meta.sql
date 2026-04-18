-- question_meta: structured overlay for Farcaster question casts.
-- See docs/hypersnap/data-layer.md § D1 Schema > Layer 1.
--
-- Side-by-side with the legacy `queries` table; no drop here. The
-- Farcaster-as-public-layer rework lives alongside the old schema until
-- dual-write verification in Phase 2 and cutover in Phase 5.
--
-- question_id is the stable PK. cast_hash is the current Farcaster anchor
-- and can change over a question's lifetime (see question_cast_history).

CREATE TABLE IF NOT EXISTS question_meta (
  question_id     TEXT PRIMARY KEY,
  cast_hash       TEXT,
  cast_status     TEXT NOT NULL DEFAULT 'active',
  author_fid      INTEGER NOT NULL,
  is_anon         INTEGER NOT NULL DEFAULT 0,
  answer_type_id  TEXT NOT NULL,
  value_schema    TEXT,
  topic_id        TEXT,
  canonical_id    TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_qmeta_cast
  ON question_meta(cast_hash) WHERE cast_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_qmeta_topic
  ON question_meta(topic_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_qmeta_canonical
  ON question_meta(canonical_id);
CREATE INDEX IF NOT EXISTS idx_qmeta_author
  ON question_meta(author_fid, created_at DESC);
