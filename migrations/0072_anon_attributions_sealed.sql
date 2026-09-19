-- Migration number: 0072 	2026-09-19T00:00:00.000Z
-- Purpose: the anon tier becomes "sealed to Q" (card t_9f2869db).
--
--   Before: an Anon answer carried its author's FID in Answers.user_id and
--   answer_meta.responder_fid, and anon_attributions.author_id held a third
--   plaintext copy (when the fire-and-forget insert succeeded at all).
--
--   After: Anon rows carry the @4n0n placeholder, and anon_attributions is the
--   single link — author_tag = HMAC(ANON_TAG_KEY, fid|question) for lookups,
--   author_ct = the FID in a SecretBox envelope for the operator path.
--   A database dump can no longer attribute an anon row; the Worker can.
--
--   This migration only reshapes the table (author_id becomes nullable, the
--   two sealed columns appear). The data moves through
--   POST /api/admin/anon-seal-migrate, which runs inside the Worker because
--   the tag key and the KEK never leave it. A later migration drops author_id
--   once the sweep reports zero legacy rows.

CREATE TABLE anon_attributions_v3 (
  id         TEXT PRIMARY KEY,
  public_id  TEXT NOT NULL UNIQUE,
  author_id  INTEGER,            -- legacy plaintext FID; NULL once sealed
  author_tag TEXT,               -- HMAC-SHA256(ANON_TAG_KEY, "<fid>|<question id>"), hex
  author_ct  TEXT,               -- SecretBox envelope of the FID (ctx anon_attributions:<public_id>|anon|0)
  type       TEXT NOT NULL,      -- 'question' | 'answer' | 'direct_query'
  created_at TEXT NOT NULL
);

INSERT INTO anon_attributions_v3 (id, public_id, author_id, type, created_at)
SELECT id, public_id, author_id, type, created_at FROM anon_attributions;

DROP TABLE anon_attributions;
ALTER TABLE anon_attributions_v3 RENAME TO anon_attributions;

CREATE INDEX IF NOT EXISTS idx_anon_attributions_public_id ON anon_attributions(public_id);
CREATE INDEX IF NOT EXISTS idx_anon_attributions_tag ON anon_attributions(author_tag, type);
CREATE INDEX IF NOT EXISTS idx_anon_attributions_legacy ON anon_attributions(author_id) WHERE author_id IS NOT NULL;

-- Rollback: recreate the 0049 shape from the same rows (author_id must be
-- restored from author_ct first — see the sweep's `unseal` phase).
