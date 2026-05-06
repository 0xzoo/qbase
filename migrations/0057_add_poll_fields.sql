-- Migration number: 0057 	 2026-05-06T00:00:00.000Z
-- Purpose: Add the two new structural fields that distinguish a "poll" from
--   a regular qbase question:
--     * closes_at        — ISO timestamp; voting locks past this point but
--                          results stay visible. NULL = evergreen (existing
--                          questions all stay this way).
--     * eligibility_gate — JSON gate config. v0 supports type 'nft_snapshot':
--                          at poll-creation we snapshot NFT holders → FIDs
--                          via Alchemy + Neynar and store the resolved list
--                          inline so the runtime check is a list lookup, not
--                          an RPC call. Shape:
--                            { "type": "nft_snapshot",
--                              "contract": "0x...",
--                              "chain": "base",
--                              "snapshot_fids": [123, 456, ...],
--                              "holder_address_count": 1240,
--                              "snapshotted_at": "2026-05-06T..." }
--                          NULL = no eligibility gate (existing behavior).

ALTER TABLE queries ADD COLUMN closes_at TEXT;        -- ISO8601, nullable
ALTER TABLE queries ADD COLUMN eligibility_gate TEXT; -- JSON, nullable

CREATE INDEX IF NOT EXISTS idx_queries_closes_at
  ON queries(closes_at)
  WHERE closes_at IS NOT NULL;

-- Rollback (if needed):
-- DROP INDEX IF EXISTS idx_queries_closes_at;
-- ALTER TABLE queries DROP COLUMN eligibility_gate;
-- ALTER TABLE queries DROP COLUMN closes_at;
