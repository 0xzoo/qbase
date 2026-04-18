-- quizzes.format: declares the creator↔respondent privacy contract.
-- See docs/hypersnap/data-layer.md § Quiz Formats.
--
--   quiz   → answers default private (envelope AES-GCM → respondent X448)
--   poll   → answers default anon (target: sealed-sender via Quil)
--   survey → answers default allowlist (envelope via group manifest)
--
-- Default is 'quiz' so existing rows (bartlet) keep today's behavior.
-- SQLite ALTER TABLE can't add CHECK, so the constraint is enforced at
-- the application layer (src/api/quizzes.ts) and documented here.

ALTER TABLE quizzes ADD COLUMN format TEXT NOT NULL DEFAULT 'quiz';
