-- bartlet: airdrop ledger, unlock ledger, cohort counter.
-- See docs/quizzes/bartlet/SPEC.md §8.

CREATE TABLE IF NOT EXISTS bartlet_airdrops (
  fid INTEGER PRIMARY KEY,       -- one airdrop per FID, ever
  sid TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  to_address TEXT NOT NULL,
  amount TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bartlet_unlocks (
  tx_hash TEXT PRIMARY KEY,
  sid TEXT NOT NULL,
  fid INTEGER NOT NULL,
  amount TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bartlet_cohort_counter (
  id INTEGER PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0
);

-- Singleton row; the route does UPDATE ... RETURNING count for atomic bumps.
INSERT OR IGNORE INTO bartlet_cohort_counter (id, count) VALUES (1, 0);
