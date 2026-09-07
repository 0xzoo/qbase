-- Migration number: 0068 	2026-09-07T03:00:00.000Z
-- Purpose: Wave cleanup (Track A6, t_bdfcf67b). A question is never gated and
--   never carries an option-set config: closes_at, eligibility_gate and
--   options_config live on `polls` only (0064, 0066, 0067). Zero read paths
--   reference the legacy queries columns any more (enforcement, snap, GET
--   payload, aggregates, results card, admin seeders all read/write polls),
--   so drop them. The 0064 closes_at mirror was already cleared by 0065.
--   The partial index from 0057 must go first: SQLite refuses to drop an
--   indexed column.
-- Related: docs/specs/question-wave-attribution.md (Phase 5)

DROP INDEX IF EXISTS idx_queries_closes_at;
ALTER TABLE queries DROP COLUMN closes_at;
ALTER TABLE queries DROP COLUMN eligibility_gate;
ALTER TABLE queries DROP COLUMN options_config;

-- Rollback (if needed): re-add the columns (data is gone; polls holds the live values).
-- ALTER TABLE queries ADD COLUMN closes_at TEXT;
-- ALTER TABLE queries ADD COLUMN eligibility_gate TEXT;
-- ALTER TABLE queries ADD COLUMN options_config TEXT;
-- CREATE INDEX IF NOT EXISTS idx_queries_closes_at ON queries(closes_at) WHERE closes_at IS NOT NULL;
