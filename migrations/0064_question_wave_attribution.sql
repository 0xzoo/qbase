-- Migration number: 0064 	2026-09-05T00:00:00.000Z
-- Purpose: Question/wave attribution. Split the fused "poll == question with
--   closes_at/eligibility_gate" into a durable question (always answerable)
--   plus a time-bounded "wave" (poll) that points at it. Answers gain a
--   nullable poll_id so a wave's tally is `answers WHERE poll_id = P`.
--   See docs/specs/question-wave-attribution.md.
--
--   * polls — one row per wave. closes_at is NOT NULL: the time gate is *what
--     makes a poll a poll*. A "poll" without a deadline is just a question.
--     (attribution via Answers.poll_id is the *mechanism*; closes_at is the
--     *definition*.) options_config folds in here (open-options = wave property).
--   * Answers.poll_id — which wave an answer belongs to. NULL = a direct
--     answer to the question (not through any wave).
--
--   Timestamps are ISO 8601 with 'T' and 'Z' (strftime, not datetime()) to
--   match every other TEXT timestamp in the schema and the Date.parse()
--   contract in EligibilityService. The backfill is idempotent: re-running
--   this file creates no duplicate polls rows and re-attributes nothing.

CREATE TABLE IF NOT EXISTS polls (
  id                TEXT PRIMARY KEY,
  question_id       TEXT NOT NULL,
  closes_at         TEXT NOT NULL,                 -- ISO8601; the time gate defines a poll
  eligibility_gate   TEXT,                          -- JSON, nullable (nft_snapshot | token_snapshot)
  options_config     TEXT,                          -- JSON, nullable (open-options: { open, cap, writeins_per_user })
  author_fid        INTEGER,                        -- who opened the wave
  cast_hash         TEXT,                           -- the cast that launched it (nullable)
  created_at        TEXT NOT NULL,                  -- ISO8601
  FOREIGN KEY (question_id) REFERENCES queries(id)
);

CREATE INDEX IF NOT EXISTS idx_polls_question_id ON polls(question_id);
CREATE INDEX IF NOT EXISTS idx_polls_closes_at ON polls(closes_at);

-- Attribution: which wave an answer belongs to. NULL = direct question answer.
-- (No FK: SQLite ALTER TABLE ADD COLUMN can't carry a constraint on an
-- existing table without a rebuild; integrity is enforced in answers/create.ts.)
ALTER TABLE Answers ADD COLUMN poll_id TEXT;
CREATE INDEX IF NOT EXISTS idx_answers_poll_id
  ON Answers(poll_id)
  WHERE poll_id IS NOT NULL;

-- ── Backfill: existing polls ──
-- Any question that already carries poll semantics (options_config /
-- closes_at / eligibility_gate) becomes a real poll. Today that is exactly
-- one row — the Farcaster season-3→4 sentiment check (6182379f, options_config
-- open, no time gate). It is temporal, so it closes one week from migration.
-- closes_at is preserved if already set, otherwise defaults to now + 7 days.
INSERT INTO polls (id, question_id, closes_at, eligibility_gate, options_config, author_fid, cast_hash, created_at)
SELECT
  lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(6))),
  q.id,
  COALESCE(q.closes_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+7 days')),
  q.eligibility_gate,
  q.options_config,
  q.coiner_fid,
  NULL,
  COALESCE(q.created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
FROM queries q
WHERE (q.options_config IS NOT NULL OR q.closes_at IS NOT NULL OR q.eligibility_gate IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM polls p WHERE p.question_id = q.id);

-- Mirror the wave's close time onto the legacy column. Until Phase 2 lands,
-- EligibilityService still reads queries.closes_at — without this the
-- backfilled poll would never actually lock. The legacy column is dropped in
-- the Phase 5 cleanup once no read path references it.
UPDATE queries
SET closes_at = (
  SELECT p.closes_at FROM polls p
  WHERE p.question_id = queries.id
  ORDER BY p.created_at LIMIT 1
)
WHERE closes_at IS NULL
  AND id IN (SELECT question_id FROM polls);

-- Attribute each backfilled poll's existing answers to its poll row. Only
-- answers that were cast before the wave closes and are not yet attributed.
UPDATE Answers
SET poll_id = (
  SELECT p.id FROM polls p
  WHERE p.question_id = Answers.q_id
  ORDER BY p.created_at LIMIT 1
)
WHERE poll_id IS NULL
  AND q_id IN (SELECT question_id FROM polls)
  AND created_at <= (
    SELECT p.closes_at FROM polls p
    WHERE p.question_id = Answers.q_id
    ORDER BY p.created_at LIMIT 1
  );

-- Rollback (if needed):
-- UPDATE Answers SET poll_id = NULL;
-- UPDATE queries SET closes_at = NULL WHERE id IN (SELECT question_id FROM polls);
-- DROP INDEX IF EXISTS idx_answers_poll_id;
-- ALTER TABLE Answers DROP COLUMN poll_id;
-- DROP INDEX IF EXISTS idx_polls_closes_at;
-- DROP INDEX IF EXISTS idx_polls_question_id;
-- DROP TABLE IF EXISTS polls;
