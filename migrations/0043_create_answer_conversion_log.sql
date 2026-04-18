-- answer_conversion_log: audit trail for private→public answer conversion.
-- See docs/hypersnap/data-layer.md § Write Path > Quiz submissions.
--
-- storage_ref is retained on answer_meta for 90 days after conversion to
-- support user-initiated revert-to-private; this log survives that
-- cleanup so audits and reverts can reconstruct what happened.

CREATE TABLE IF NOT EXISTS answer_conversion_log (
  id                  TEXT PRIMARY KEY,
  answer_id           TEXT NOT NULL,
  question_id         TEXT NOT NULL,
  old_storage_ref     TEXT,
  new_reply_cast_hash TEXT,
  actor_fid           INTEGER NOT NULL,
  direction           TEXT NOT NULL,
  converted_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_acl_answer
  ON answer_conversion_log(answer_id, converted_at DESC);
CREATE INDEX IF NOT EXISTS idx_acl_question
  ON answer_conversion_log(question_id, converted_at DESC);
CREATE INDEX IF NOT EXISTS idx_acl_actor
  ON answer_conversion_log(actor_fid, converted_at DESC);
