-- Migration number: 0077 	2026-09-27T00:00:00.000Z
-- Purpose: one row per (wave, chain) its record was committed on.
--
--   wave_commitments (0075) holds the bundle and the first commit's tx. When
--   ENSv2 reaches mainnet, the same records are written again to the mainnet
--   name from D1 and the unchanged Arweave bundles; both commits must stay on
--   file, because the earlier one (Sepolia) is the evidence of when the result
--   was first committed and the later one (mainnet) is where readers look.
--
--   ens_name   the name written to on that chain (the same label everywhere)
--   note       free text, e.g. "replayed from sepolia <tx>"

CREATE TABLE IF NOT EXISTS wave_chain_commits (
  poll_id       TEXT NOT NULL,
  chain_id      INTEGER NOT NULL,
  ens_name      TEXT NOT NULL,
  tx_hash       TEXT NOT NULL,
  committed_at  TEXT NOT NULL,
  note          TEXT,
  PRIMARY KEY (poll_id, chain_id)
);

-- Carry over what 0075 already recorded.
INSERT OR IGNORE INTO wave_chain_commits (poll_id, chain_id, ens_name, tx_hash, committed_at)
SELECT poll_id, chain_id, ens_name, tx_hash, committed_at
FROM wave_commitments
WHERE status = 'committed' AND chain_id IS NOT NULL AND tx_hash IS NOT NULL AND committed_at IS NOT NULL;
