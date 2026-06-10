-- Migration number: 0061     2026-05-30T00:00:00.000Z
-- Purpose: Ledger for OracleAgent — multi-model AI mention dispatcher.
-- Each row records a cast that mentioned @qlaude/@chatqpt/@qemini,
-- which providers were dispatched, the responses received, and any
-- Qbase question created from the exchange.
--
-- See worker/agents/OracleAgent.ts

CREATE TABLE IF NOT EXISTS oracle_ledger (
  id TEXT PRIMARY KEY,
  cast_hash TEXT NOT NULL UNIQUE,
  author_fid INTEGER NOT NULL,
  author_username TEXT,
  cast_text TEXT NOT NULL,
  mentioned_providers TEXT NOT NULL,    -- JSON array: ["anthropic","openai","google"]
  responses TEXT NOT NULL,              -- JSON object: { anthropic: { response, model, latency_ms, tokens }, ... }
  question_id TEXT,                     -- FK to queries.id if a question was created
  question_created INTEGER DEFAULT 0,   -- boolean
  created_at INTEGER NOT NULL           -- epoch ms
);

CREATE INDEX IF NOT EXISTS idx_oracle_ledger_author ON oracle_ledger(author_fid);
CREATE INDEX IF NOT EXISTS idx_oracle_ledger_created ON oracle_ledger(created_at);
CREATE INDEX IF NOT EXISTS idx_oracle_ledger_question ON oracle_ledger(question_id);
