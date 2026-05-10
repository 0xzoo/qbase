-- Generalize the bartlet airdrop ledger + cohort counter into shared tables
-- keyed by quiz_id, so values (and hot takes, and any future bespoke quizzes)
-- can run airdrops through the same pipeline.
--
-- Old bartlet_airdrops + bartlet_cohort_counter remain in place for now —
-- once we verify the new path works end-to-end on bartlet they can be
-- dropped in a follow-up migration. Keeping them avoids data loss if the
-- refactor needs to roll back.

CREATE TABLE IF NOT EXISTS quiz_airdrops (
  quiz_id    TEXT    NOT NULL,
  fid        INTEGER NOT NULL,
  sid        TEXT    NOT NULL,
  tx_hash    TEXT    NOT NULL,
  to_address TEXT    NOT NULL,
  amount     TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (quiz_id, fid)
);

CREATE INDEX IF NOT EXISTS idx_quiz_airdrops_fid ON quiz_airdrops(fid);
CREATE INDEX IF NOT EXISTS idx_quiz_airdrops_created_at ON quiz_airdrops(created_at);

-- Per-quiz cohort counter. The pipeline does an atomic UPDATE ... RETURNING
-- to bump-and-read in one step; cap is enforced after the bump.
CREATE TABLE IF NOT EXISTS quiz_cohort_counters (
  quiz_id TEXT    PRIMARY KEY,
  count   INTEGER NOT NULL DEFAULT 0,
  cap     INTEGER NOT NULL
);

-- Migrate bartlet rows into the new tables. Idempotent: INSERT OR IGNORE
-- means re-running the migration is safe.
INSERT OR IGNORE INTO quiz_airdrops (quiz_id, fid, sid, tx_hash, to_address, amount, created_at)
SELECT 'bartlet', fid, sid, tx_hash, to_address, amount, created_at
FROM bartlet_airdrops;

-- Bartlet's cohort counter starts as a singleton row at id=1; copy its count.
INSERT OR IGNORE INTO quiz_cohort_counters (quiz_id, count, cap)
SELECT 'bartlet', count, 1000 FROM bartlet_cohort_counter WHERE id = 1;

-- Seed values cohort counter at zero with the same 1000-slot cap. Bartlet
-- and values keep separate pools — completing one doesn't burn a slot in
-- the other.
INSERT OR IGNORE INTO quiz_cohort_counters (quiz_id, count, cap)
VALUES ('values', 0, 1000);
