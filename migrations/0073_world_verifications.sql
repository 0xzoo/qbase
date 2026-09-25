-- Migration number: 0073 	2026-09-26T00:00:00.000Z
-- Purpose: verified-human answering (World ID / IDKit) on waves whose
-- eligibility_gate is {type: "world_id"}.
--
--   One row per (World action, nullifier). Each world_id wave has its own
--   action (qbase-wave-<poll_id>), and a nullifier is scoped to its action,
--   so a row means "one unique human has answered this wave" and nothing
--   links one human's rows across waves.
--
--   No account column and no answer id, on purpose: the uniqueness record is
--   not a second copy of who answered. The answer itself is an ordinary
--   Answers row owned by the answering account.
--
--   nullifier is the decimal string of the field element. It is TEXT, not
--   NUMERIC(78,0) as in World's recipe: SQLite stores oversized NUMERIC values
--   as REAL, so two different humans' nullifiers can round to the same value
--   and the second is rejected as a duplicate.

CREATE TABLE world_verifications (
  action     TEXT NOT NULL,
  nullifier  TEXT NOT NULL,
  poll_id    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (action, nullifier)
);

CREATE INDEX idx_world_verifications_poll ON world_verifications(poll_id);
