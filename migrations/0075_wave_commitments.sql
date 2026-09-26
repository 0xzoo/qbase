-- Migration number: 0075 	2026-09-26T00:00:00.000Z
-- Purpose: committed wave records (ETHGlobal Tokyo piece 3, plan
-- 2026-09-25 §7.4). When a wave closes, the archive job builds a bundle of
-- its result (canonical JSON), posts it to Arweave and writes its hash and
-- summary to the question's ENS name. One row per wave, idempotent on poll_id.
--
--   bundle_json     the exact bytes that were hashed, kept so a retry posts
--                   the same bundle (handles can change between attempts)
--                   and so qbase can serve it when Arweave is unavailable
--   committed_tally the tally inside the bundle, for the results page; the
--                   verify route checks the live tally against the bundle
--                   fetched back from Arweave, not against this column
--   status          building | posted | committed | awaiting_name | failed
--
-- No answer-level or respondent-keyed column: per-row attribution lives only
-- in the bundle, and only for Public answers.

CREATE TABLE IF NOT EXISTS wave_commitments (
  poll_id          TEXT PRIMARY KEY,
  question_id      TEXT NOT NULL,
  ens_name         TEXT NOT NULL,
  status           TEXT NOT NULL,
  bundle_json      TEXT NOT NULL,
  bundle_sha256    TEXT NOT NULL,
  committed_tally  TEXT NOT NULL,
  ar_tx            TEXT,
  ar_error         TEXT,
  chain_id         INTEGER,
  tx_hash          TEXT,
  error            TEXT,
  attempts         INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  committed_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_wave_commitments_question ON wave_commitments(question_id, committed_at);
