-- pending_cast_index: staging table for Hypersnap webhook ingestion.
-- See docs/hypersnap/data-layer.md § Indexer & Reconciliation Pipeline.
--
-- Every cast.created webhook for a cast with a qbase.tech/q/ embed writes
-- a row here. The reconciler (30s cron, Phase 2) walks reconciled=0 rows
-- and aligns them with question_meta per the five-case matrix in the spec.

CREATE TABLE IF NOT EXISTS pending_cast_index (
  cast_hash       TEXT PRIMARY KEY,
  question_id     TEXT,
  author_fid      INTEGER NOT NULL,
  cast_text       TEXT,
  parent_hash     TEXT,
  first_seen_at   INTEGER NOT NULL,
  reconciled      INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER,
  notes           TEXT
);

CREATE INDEX IF NOT EXISTS idx_pending_unreconciled
  ON pending_cast_index(reconciled, first_seen_at) WHERE reconciled = 0;
CREATE INDEX IF NOT EXISTS idx_pending_parent
  ON pending_cast_index(parent_hash) WHERE parent_hash IS NOT NULL;
