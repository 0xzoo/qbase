-- Migration number: 0069     2026-09-07T00:00:00.000Z
-- Purpose: paid council (docs/specs/paid-council.md).
--
-- council_summons: one row per summon attempt, from the web (button on the
-- question page) or from a "@qgent council" reply cast. Carries the price
-- charged and the on-chain deduction tx. summon_cast_hash is UNIQUE so a
-- webhook replay cannot summon (or charge) twice.
--
-- council_responses: each model's answer text (and the cast hash when the
-- question has a cast), rendered as the question's Council thread.

CREATE TABLE IF NOT EXISTS council_summons (
  id TEXT PRIMARY KEY,
  question_id TEXT,                          -- NULL when the summoned cast is not a qbase question
  fid INTEGER NOT NULL,                      -- the summoner (pays from their stake)
  source TEXT NOT NULL CHECK (source IN ('web', 'cast')),
  summon_cast_hash TEXT UNIQUE,              -- the "@qgent council" reply (cast path)
  parent_cast_hash TEXT,                     -- the question cast the models replied to
  price TEXT NOT NULL DEFAULT '0',           -- whole $QQ charged ('0' while the gate is off)
  status TEXT NOT NULL DEFAULT 'pending',    -- pending | answered | failed
  deduction_tx TEXT,                         -- Base tx hash of OracleEscrow.recordDeduction
  error TEXT,
  created_at INTEGER NOT NULL,               -- epoch ms
  answered_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_council_summons_question ON council_summons(question_id, created_at);
CREATE INDEX IF NOT EXISTS idx_council_summons_fid ON council_summons(fid, created_at);

CREATE TABLE IF NOT EXISTS council_responses (
  id TEXT PRIMARY KEY,
  summon_id TEXT NOT NULL REFERENCES council_summons(id),
  question_id TEXT,
  parent_cast_hash TEXT,
  model TEXT NOT NULL,                       -- qlaude | qemini | chatqpt
  text TEXT NOT NULL,                        -- '' when the model failed (see error)
  cast_hash TEXT,                            -- last cast of the reply chain, when cast
  model_id TEXT,
  tokens INTEGER,
  latency_ms INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_council_responses_question ON council_responses(question_id, created_at);
CREATE INDEX IF NOT EXISTS idx_council_responses_parent ON council_responses(parent_cast_hash);
CREATE INDEX IF NOT EXISTS idx_council_responses_summon ON council_responses(summon_id);
