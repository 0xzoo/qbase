-- Snap Polls: silent vote storage + snap flag on questions
--
-- 1. answer_snap — silent vote storage for in-feed poll interactions
--    Snap answers are distinct from cast-backed answers:
--    - No cast hash, no public attribution
--    - One vote per FID per question per session (UPSERT on conflict)
--    - snap_session_id enables future timed research windows
--      (v1: all votes use a canonical session derived from question_id)
--
-- 2. question_meta.has_snap — flag to skip fc:miniapp meta tag injection
--    When has_snap=1, the question page serves snap JSON via content
--    negotiation instead of the miniapp launch button.

CREATE TABLE IF NOT EXISTS answer_snap (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id   TEXT    NOT NULL,
  fid           INTEGER NOT NULL,
  option_index  INTEGER NOT NULL,
  snap_session_id TEXT  NOT NULL DEFAULT '',  -- future: timed windows partition by session
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(question_id, fid, snap_session_id)
);

CREATE INDEX IF NOT EXISTS idx_answer_snap_question ON answer_snap(question_id);
CREATE INDEX IF NOT EXISTS idx_answer_snap_session  ON answer_snap(question_id, snap_session_id);

-- Add has_snap flag to question_meta (0 = miniapp default, 1 = snap poll)
ALTER TABLE question_meta ADD COLUMN has_snap INTEGER NOT NULL DEFAULT 0;
