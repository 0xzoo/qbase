-- Migration number: 0063 	 2026-06-27T00:00:00.000Z
-- Purpose: Open-options polls — MC polls whose option set is open. A respondent
--   votes an existing option or writes in a new one, which instantly becomes a
--   first-class, votable option. The option space itself becomes the data.
--   See docs/plans/open-options-poll.md.
--
--     * queries.options_config — nullable JSON. NULL → classic closed MC (zero
--                                behavior change; same pattern as closes_at /
--                                eligibility_gate). When set:
--                                  { "open": true, "cap": 24, "writeins_per_user": 1 }
--     * poll_options           — one row per option (seed or write-in). Row-level
--                                inserts so concurrent write-ins don't collide on
--                                a JSON blob. Dedup is enforced by
--                                UNIQUE(q_id, label_norm). Attribution
--                                (created_by_fid) is server-side only and never
--                                shipped to the wire.

ALTER TABLE queries ADD COLUMN options_config TEXT; -- JSON, nullable

CREATE TABLE IF NOT EXISTS poll_options (
  id              TEXT PRIMARY KEY,
  q_id            TEXT NOT NULL,
  label           TEXT NOT NULL,                   -- display text (<= 60 chars)
  label_norm      TEXT NOT NULL,                   -- normalized for dedup (trim/lower/collapse ws)
  source          TEXT NOT NULL DEFAULT 'writein', -- 'seed' | 'writein'
  created_by_fid  INTEGER,                         -- server-side only; never sent to clients
  created_at      TEXT NOT NULL,                   -- ISO8601
  hidden          INTEGER NOT NULL DEFAULT 0,
  UNIQUE (q_id, label_norm)
);

-- List a poll's options in declared order (seeds first, then write-ins
-- chronologically). created_at is the primary sort; rowid breaks ties between
-- same-timestamp seeds, preserving the creator's declared option order.
CREATE INDEX IF NOT EXISTS idx_poll_options_q_created
  ON poll_options(q_id, created_at);

-- Rollback (if needed):
-- DROP INDEX IF EXISTS idx_poll_options_q_created;
-- DROP TABLE IF EXISTS poll_options;
-- ALTER TABLE queries DROP COLUMN options_config;
