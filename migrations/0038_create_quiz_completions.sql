-- quiz_completions: temporal snapshots of quiz results.
-- See docs/answers/answers-plan.md for the broader architecture.
--
-- Privacy model:
--   visibility = 'private'  → answers_encrypted has Q Storage ref, answers_snapshot is NULL
--   visibility = 'public'   → answers_snapshot has plaintext JSON, answers_encrypted may remain
--   visibility = 'anon'     → user_id is anon bot FID, real author in anon_attributions
--
-- scores + result_category are always plaintext (non-sensitive derived data).

CREATE TABLE IF NOT EXISTS quiz_completions (
  id TEXT PRIMARY KEY,
  quiz_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  completed_at INTEGER NOT NULL,
  answers_encrypted TEXT,                          -- Q Storage ref when private
  answers_snapshot TEXT,                            -- plaintext JSON when public/revealed
  scores TEXT,                                     -- JSON: {dimension: score, ...}
  result_category TEXT,                            -- e.g. "EXPLORER", "SOCIALIZER"
  visibility TEXT NOT NULL DEFAULT 'private',       -- 'private' | 'public' | 'anon'
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_qc_quiz ON quiz_completions(quiz_id, completed_at DESC);
CREATE INDEX idx_qc_user ON quiz_completions(user_id, completed_at DESC);
