-- answer_meta: tier-uniform answer metadata.
-- See docs/hypersnap/data-layer.md § D1 Schema > Layer 1.
--
-- For public answers, reply_cast_hash points to the Farcaster reply and
-- storage_ref is NULL. For private/anon/allowlist, reply_cast_hash is NULL
-- and storage_ref points to a QStorage blob.
--
-- FK is on question_id (stable), NOT cast_hash, so answers stay linked
-- across 4n0n re-anchors. replied_to_hash records which cast generation
-- the reply targeted; useful when rendering orphaned-parent answers.
--
-- pending=1 is set when a public answer is enqueued for cast posting but
-- the webhook hasn't filled in reply_cast_hash yet. See the queue consumer
-- in worker/index.ts and the webhook receiver in worker/routes/webhooks.ts.

CREATE TABLE IF NOT EXISTS answer_meta (
  id              TEXT PRIMARY KEY,
  question_id     TEXT NOT NULL,
  reply_cast_hash TEXT,
  replied_to_hash TEXT,
  responder_fid   INTEGER,
  privacy_tier    TEXT NOT NULL,
  storage_ref     TEXT,
  primary_value   TEXT,
  answer_index    INTEGER,
  pending         INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ameta_question
  ON answer_meta(question_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ameta_responder
  ON answer_meta(responder_fid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ameta_reply
  ON answer_meta(reply_cast_hash) WHERE reply_cast_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ameta_pending
  ON answer_meta(pending, created_at) WHERE pending = 1;
