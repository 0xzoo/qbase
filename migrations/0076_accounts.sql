-- The qbase account as root identity (docs/specs/account-root.md, option 2).
--
-- Additive only. Every account gets a fresh random id in [2^40, 2^53); a
-- Farcaster fid lives only in account_credentials. Fids are < 2^32, so a
-- value in a person-key column says by itself whether it has been rewritten.
--
-- Filled and cut over by POST /api/admin/account-migrate (phases accounts →
-- rewrite → reowner → retag), not here. Until account_migration.state is
-- 'rewritten' the worker behaves exactly as before (user key = fid).
--
-- 0073-0075 are reserved by the ETHGlobal build.

CREATE TABLE IF NOT EXISTS accounts (
  id          INTEGER PRIMARY KEY,   -- >= 2^40, random, never reused
  born_from   TEXT NOT NULL,         -- 'farcaster' | 'passkey' | 'ethereum' | 'world' | 'legacy'
  legacy_key  INTEGER UNIQUE,        -- the pre-rewrite person key (a fid, or a legacy placeholder); NULL if born after
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS account_credentials (
  kind          TEXT NOT NULL,       -- 'farcaster' | 'passkey' | 'ethereum' | 'world'
  value         TEXT NOT NULL,       -- fid as decimal text | Qm… address | 0x… lowercase | '<iss>|<sub>'
  account_id    INTEGER NOT NULL,
  label         TEXT,                -- display only: ENS name, fname, device name
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER,
  PRIMARY KEY (kind, value)
);

CREATE INDEX IF NOT EXISTS idx_account_credentials_account ON account_credentials(account_id);

CREATE TABLE IF NOT EXISTS account_migration (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  state         TEXT NOT NULL,       -- 'accounts' | 'rewritten'
  rewritten_at  INTEGER
);

-- Old values for the remaps that are not invertible through legacy_key
-- (the legacy anon placeholder, question authorship mapped through coiner_fid),
-- so the rewrite can be undone exactly.
CREATE TABLE IF NOT EXISTS account_rewrite_log (
  tbl        TEXT NOT NULL,
  row_key    TEXT NOT NULL,
  col        TEXT NOT NULL,
  old_value  INTEGER,
  PRIMARY KEY (tbl, row_key, col)
);
