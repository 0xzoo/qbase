-- Grants to consumers + the read log (docs/specs/consent-model.md §4–§5,
-- personal-mcp.md §3.1/§3.4). A personal MCP key is a grant with
-- consumer_kind = 'key'; counterparty / match / broker grants use the same
-- table later. Every read through a grant is logged in grant_reads and shown
-- to the owner at /me/access. The log holds counts and tiers, never the
-- agent's query: a decision ("should I leave my job") is as sensitive as an
-- answer and would be plaintext here.
--
-- 0078 is taken by hack/ensv2-commit (wave_chain_commits); 0073-0075 are
-- reserved by the ETHGlobal build. The contribution switches of consent-model
-- §3/§5 (contribution_settings / _events / _builds) land with the L1 work that
-- reads them, not here.

-- Copy shown when something consent-bearing was created, by version.
CREATE TABLE IF NOT EXISTS consent_copy (
  id          TEXT PRIMARY KEY,      -- e.g. 'mcp-key-v1'
  surface     TEXT NOT NULL,         -- where it was shown: 'me-access:create-key'
  text        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS grants (
  id             TEXT PRIMARY KEY,
  owner_key      INTEGER NOT NULL,   -- person key (account id after the cutover)
  consumer_kind  TEXT NOT NULL,      -- 'key' (owner's agent) | 'account' | 'buyer'
  consumer_id    TEXT,               -- for 'key': NULL (the key is the consumer); else the account / buyer id
  label          TEXT,               -- owner's name for it: "yu via hermes"
  key_hash       TEXT UNIQUE,        -- 'key' only: sha-256 hex of the bearer secret; the secret is shown once
  key_hint       TEXT,               -- 'key' only: last 4 chars, so the owner can tell keys apart
  domains        TEXT NOT NULL DEFAULT '*',          -- '*' or a JSON array of topic strings
  disclosure     TEXT NOT NULL DEFAULT 'raw',        -- 'derived' | 'raw'
  ceiling        TEXT NOT NULL DEFAULT 'Public',     -- 'Public' | 'Anon' | 'Secret'
  purpose        TEXT,
  expires_at     INTEGER,            -- ms; required for anyone but the owner's own agents
  revoked_at     INTEGER,
  copy_id        TEXT,               -- consent_copy.id shown at creation
  created_at     INTEGER NOT NULL,
  last_used_at   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_grants_owner ON grants(owner_key);

CREATE TABLE IF NOT EXISTS grant_reads (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  grant_id      TEXT NOT NULL,
  tool          TEXT NOT NULL,       -- 'get_context' | 'search_my_positions' | …
  answer_count  INTEGER NOT NULL,    -- answers whose content was served
  max_tier      TEXT,                -- highest tier among them: 'Public' | 'Anon' | 'Secret' | NULL when none
  at            INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_grant_reads_grant ON grant_reads(grant_id, at);

INSERT OR IGNORE INTO consent_copy (id, surface, text, created_at) VALUES (
  'mcp-key-v1',
  'me-access:create-key',
  'This key lets an AI agent read your qbase answers up to the tier you pick. Anything it reads is seen by the agent and by the company that runs its model. Every read is logged here, and you can revoke the key at any time; revoking stops future reads, not ones already made. Anon answers it reads are linked to you in that agent''s context.',
  1791331200000
);
