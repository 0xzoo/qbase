-- The qbase account as root identity (docs/specs/account-root.md).
--
-- Additive only: three new tables, nothing existing is touched. An account id
-- is the integer rows already carry: an existing user's account id is their
-- Users.fid; accounts born from a Farcaster login get id = fid; accounts born
-- from any other credential get a fresh negative id from account_id_seq.
--
-- The tables are filled by scripts/accounts-backfill.ts (reviewed SQL, run
-- separately), not here. Until then the worker falls back to the fid path.
--
-- 0073-0075 are reserved by the ETHGlobal build (world_verifications,
-- agent_approvals, wave_commitments).

CREATE TABLE IF NOT EXISTS accounts (
  id          INTEGER PRIMARY KEY,
  born_from   TEXT NOT NULL,          -- 'farcaster' | 'passkey' | 'ethereum' | 'world' | 'legacy'
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS account_credentials (
  kind          TEXT NOT NULL,        -- 'farcaster' | 'passkey' | 'ethereum' | 'world'
  value         TEXT NOT NULL,        -- fid as decimal text | Qm… address | 0x… lowercase | '<iss>|<sub>'
  account_id    INTEGER NOT NULL,
  label         TEXT,                 -- display only: ENS name, fname, device name
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER,
  PRIMARY KEY (kind, value)
);

CREATE INDEX IF NOT EXISTS idx_account_credentials_account ON account_credentials(account_id);

CREATE TABLE IF NOT EXISTS account_id_seq (
  id    INTEGER PRIMARY KEY CHECK (id = 1),
  next  INTEGER NOT NULL              -- next negative id to hand out
);
