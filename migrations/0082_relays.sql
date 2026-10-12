-- Relayed answers (docs/specs/personal-mcp.md §3.3): an agent records
-- an answer the owner gave it in conversation (record_answer). The answer is
-- an ordinary Secret row (`Answers` audience 'Private', or `owner_answers` for
-- an owner-only question); this table is the mark that says an agent wrote it
-- and the owner hasn't confirmed it yet.
--
-- One table for both kinds rather than a column on each: the inbox lists them
-- together, revocation deletes a key's relays in one statement, and confirming
-- is deleting the row, so nothing of the mark survives a confirm. It is no new
-- link: both answer kinds are already keyed to the owner in plaintext, and a
-- relay is always Secret. A relayed answer never leaves Secret with its mark:
-- the inbox confirm and applyAnswerUpdate both delete the row first.

CREATE TABLE IF NOT EXISTS relays (
  answer_id     TEXT PRIMARY KEY,    -- Answers.id or owner_answers.id
  kind          TEXT NOT NULL,       -- 'answer' | 'owner_answer'
  owner_key     INTEGER NOT NULL,
  grant_id      TEXT NOT NULL,       -- the key that recorded it (grants.id)
  ask_id        TEXT,                -- the ask item it answered, if any
  ask_position  INTEGER,
  created_at    INTEGER NOT NULL     -- ms
);

CREATE INDEX IF NOT EXISTS idx_relays_owner ON relays(owner_key, created_at);
CREATE INDEX IF NOT EXISTS idx_relays_grant ON relays(grant_id);
