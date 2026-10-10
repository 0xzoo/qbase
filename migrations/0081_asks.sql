-- Personal MCP P1 (docs/specs/personal-mcp.md §3.2–3.3): an agent asks its
-- owner questions through an inbox, and questions only the owner can see.
--
-- Owner-only questions and their answers get their own tables rather than a
-- visibility flag on `queries`: `queries` is read by ~50 statements across the
-- worker (feeds, search, OG, snaps, casts, the open release), and one missed
-- filter would put a private stem on a public surface. Nothing outside
-- worker/services/personal/ reads these tables.
--
-- Everything that says something about the owner is sealed (SecretBox,
-- `sealed` column, AAD `<table>:<id>|Secret|<owner_key>`): the decision an
-- agent asked about, its reasons, the item list, owner-only stems and their
-- answers. An ask's item list and per-item progress live inside its sealed
-- blob, not in columns, so the database never pairs an owner with the public
-- questions they were asked or when they answered them: an Anon answer given
-- from the inbox can't be linked back by timing.

CREATE TABLE IF NOT EXISTS asks (
  id          TEXT PRIMARY KEY,
  owner_key   INTEGER NOT NULL,
  grant_id    TEXT NOT NULL,       -- the key that asked (grants.id)
  status      TEXT NOT NULL DEFAULT 'pending',   -- 'pending' | 'answered' | 'declined'
  sealed      TEXT NOT NULL,       -- {decision, why_needed, note, items: [{question_id, answered, skipped}]}
  created_at  INTEGER NOT NULL     -- ms
);

CREATE INDEX IF NOT EXISTS idx_asks_owner ON asks(owner_key, status, created_at);
CREATE INDEX IF NOT EXISTS idx_asks_grant ON asks(grant_id, status, created_at);

CREATE TABLE IF NOT EXISTS owner_questions (
  id          TEXT PRIMARY KEY,    -- 'oq_<uuid>'
  owner_key   INTEGER NOT NULL,
  type        TEXT NOT NULL,       -- 'text' | 'mc' | 'checkbox' | 'scale'
  sealed      TEXT NOT NULL,       -- {stem, options?, scale?}
  ask_id      TEXT,                -- the ask that wrote it
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_owner_questions_owner ON owner_questions(owner_key);

-- Append-only like Answers: a re-answer is a change of mind with a date.
CREATE TABLE IF NOT EXISTS owner_answers (
  id                 TEXT PRIMARY KEY,
  owner_question_id  TEXT NOT NULL,
  owner_key          INTEGER NOT NULL,
  sealed             TEXT NOT NULL,   -- {value, reasoning}
  created_at         TEXT NOT NULL    -- ISO, like Answers.created_at
);

CREATE INDEX IF NOT EXISTS idx_owner_answers_owner ON owner_answers(owner_key, owner_question_id);
