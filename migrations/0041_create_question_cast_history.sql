-- question_cast_history: every Farcaster anchor a question has ever had.
-- See docs/hypersnap/data-layer.md § Cast Lifecycle.
--
-- Populated whenever question_meta.cast_hash transitions (deletion,
-- 4n0n re-anchor, or author recast). Enables reply resolution for
-- answers written against prior anchor generations.

CREATE TABLE IF NOT EXISTS question_cast_history (
  question_id     TEXT NOT NULL,
  cast_hash       TEXT NOT NULL,
  author_fid      INTEGER NOT NULL,
  status          TEXT NOT NULL,
  transitioned_at INTEGER NOT NULL,
  PRIMARY KEY (question_id, cast_hash)
);

CREATE INDEX IF NOT EXISTS idx_qch_question
  ON question_cast_history(question_id, transitioned_at DESC);
