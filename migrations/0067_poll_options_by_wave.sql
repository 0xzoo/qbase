-- Migration number: 0067 	2026-09-07T02:00:00.000Z
-- Purpose: Open-options fold (Track A5, t_91edcc8d). Write-in options belong
--   to a wave, not the question: a fresh wave starts from the question's
--   declared a_options and grows its own option set. Re-key poll_options
--   from q_id to poll_id. SQLite cannot rename a column inside a UNIQUE
--   constraint, so this is a table rebuild. Existing rows attach to the
--   question's first wave. An open-options question that never got a wave
--   (created through the pre-A2 form without a close time — 802af5e9 is one)
--   first gets a wave backfilled exactly the way 0064 did it (closes one week
--   from migration, author = coiner), so no option row is ever orphaned.
--   Also copies queries.options_config onto any wave still missing it, so
--   openness/cap can be read from polls only.
-- Related: docs/specs/question-wave-attribution.md (decision 1)

-- ── Backfill: a wave for every open-options question that has none ──
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

-- Attribute that question's existing answers to its new wave (same rule as 0064).
UPDATE Answers
SET poll_id = (
  SELECT p.id FROM polls p
  WHERE p.question_id = Answers.q_id
  ORDER BY p.created_at ASC, p.rowid ASC LIMIT 1
)
WHERE poll_id IS NULL
  AND q_id IN (SELECT question_id FROM polls)
  AND q_id IN (SELECT q_id FROM poll_options)
  AND created_at <= (
    SELECT p.closes_at FROM polls p
    WHERE p.question_id = Answers.q_id
    ORDER BY p.created_at ASC, p.rowid ASC LIMIT 1
  );

CREATE TABLE poll_options_new (
  id              TEXT PRIMARY KEY,
  poll_id         TEXT NOT NULL,
  label           TEXT NOT NULL,                   -- display text (<= 60 chars)
  label_norm      TEXT NOT NULL,                   -- normalized for dedup (trim/lower/collapse ws)
  source          TEXT NOT NULL DEFAULT 'writein', -- 'seed' | 'writein'
  created_by_fid  INTEGER,                         -- server-side only; never sent to clients
  created_at      TEXT NOT NULL,                   -- ISO8601
  hidden          INTEGER NOT NULL DEFAULT 0,
  UNIQUE (poll_id, label_norm),
  FOREIGN KEY (poll_id) REFERENCES polls(id)
);

INSERT OR IGNORE INTO poll_options_new
  (id, poll_id, label, label_norm, source, created_by_fid, created_at, hidden)
SELECT
  o.id,
  (SELECT p.id FROM polls p WHERE p.question_id = o.q_id ORDER BY p.created_at ASC, p.rowid ASC LIMIT 1),
  o.label, o.label_norm, o.source, o.created_by_fid, o.created_at, o.hidden
FROM poll_options o
WHERE EXISTS (SELECT 1 FROM polls p WHERE p.question_id = o.q_id);

DROP INDEX IF EXISTS idx_poll_options_q_created;
DROP TABLE poll_options;
ALTER TABLE poll_options_new RENAME TO poll_options;

-- List a wave's options in declared order (seeds first, then write-ins
-- chronologically); rowid breaks same-timestamp ties among seeds.
CREATE INDEX IF NOT EXISTS idx_poll_options_poll_created
  ON poll_options(poll_id, created_at);

UPDATE polls
SET options_config = (SELECT q.options_config FROM queries q WHERE q.id = polls.question_id)
WHERE options_config IS NULL
  AND EXISTS (SELECT 1 FROM queries q WHERE q.id = polls.question_id AND q.options_config IS NOT NULL);

-- Rollback (if needed): rebuild the q_id-keyed table from polls.question_id.
-- CREATE TABLE poll_options_old (... UNIQUE (q_id, label_norm));
-- INSERT INTO poll_options_old SELECT o.id, p.question_id, o.label, o.label_norm, o.source,
--   o.created_by_fid, o.created_at, o.hidden FROM poll_options o JOIN polls p ON p.id = o.poll_id;
-- DROP TABLE poll_options; ALTER TABLE poll_options_old RENAME TO poll_options;
