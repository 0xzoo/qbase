-- Migration 0049: Make fid the primary key of Users
-- Phase 1 step 2: swap PKs, rebuild tables, update FKs
--
-- D1 requires table rebuild pattern (no ALTER DROP COLUMN)
-- Steps:
--   1. Fix passkey-only users with NULL fid (synthetic negative FIDs)
--   2. Create Users_v2 with fid as PK, copy data, swap
--   3. Rebuild Answers: drop FK to Users, update user_id = fid
--   4. Rebuild anon_attributions: drop FK to Users, update author_id = fid
--   5. Drop Users_old, clean up stale indexes

-- Step 0: Fix passkey-only users with NULL fid (assign synthetic negative FIDs)
-- These users have zero data (no answers, no queries) — safe to assign placeholders
UPDATE Users SET fid = -1 WHERE id = 18 AND fid IS NULL;
UPDATE Users SET fid = -2 WHERE id = 19 AND fid IS NULL;

-- Step 1: Create Users_v2 with fid as PRIMARY KEY (no auto-increment id)
CREATE TABLE Users_v2 (
  fid              INTEGER PRIMARY KEY,
  fname            TEXT,
  created_at       NUMBER DEFAULT CURRENT_TIMESTAMP,
  primary_address  TEXT,
  q_cost           NUMBER DEFAULT 3,
  socials          TEXT,
  pro_status       TEXT DEFAULT NULL,
  pro_expires_at   TEXT DEFAULT NULL,
  username         TEXT,
  quil_address     TEXT,
  fc_opt_in        INTEGER DEFAULT 0,
  display_name     TEXT,
  pfp_url          TEXT,
  bio              TEXT,
  profile_source   TEXT DEFAULT 'farcaster'
);

INSERT INTO Users_v2 (fid, fname, created_at, primary_address, q_cost, socials,
  pro_status, pro_expires_at, username, quil_address, fc_opt_in,
  display_name, pfp_url, bio, profile_source)
SELECT fid, fname, created_at, primary_address, q_cost, socials,
  pro_status, pro_expires_at, username, quil_address, fc_opt_in,
  display_name, pfp_url, bio, profile_source
FROM Users;

ALTER TABLE Users RENAME TO Users_old;
ALTER TABLE Users_v2 RENAME TO Users;

-- Step 2: Rebuild Answers without FK to Users (FK to queries only)
-- Need explicit column list because 0048 added fid column we're dropping
CREATE TABLE Answers_v2 (
  id                           TEXT PRIMARY KEY,
  q_id                         TEXT NOT NULL,
  user_id                      INTEGER NOT NULL,
  value                        TEXT NOT NULL,
  answer_type_id               TEXT NOT NULL,
  audience                     TEXT NOT NULL,
  created_at                   TEXT NOT NULL,
  allowlist_data               TEXT,
  primary_type                 TEXT DEFAULT 'identity',
  reasoning                    TEXT,
  topics                       TEXT,
  answer_type_id_new           INTEGER,
  suggested_answer_type_id_new INTEGER,
  value_new                    TEXT,
  answer_data                  TEXT,
  storage_ref                  TEXT,
  FOREIGN KEY (q_id) REFERENCES queries(id)
);

INSERT INTO Answers_v2 (id, q_id, user_id, value, answer_type_id, audience, created_at,
  allowlist_data, primary_type, reasoning, topics, answer_type_id_new,
  suggested_answer_type_id_new, value_new, answer_data, storage_ref)
SELECT id, q_id, user_id, value, answer_type_id, audience, created_at,
  allowlist_data, primary_type, reasoning, topics, answer_type_id_new,
  suggested_answer_type_id_new, value_new, answer_data, storage_ref
FROM Answers;

DROP TABLE Answers;
ALTER TABLE Answers_v2 RENAME TO Answers;
CREATE INDEX IF NOT EXISTS idx_answers_user_id ON Answers(user_id);

-- Step 3: Update user_id to fid values (lookup from Users_old which has both id and fid)
UPDATE Answers SET user_id = (SELECT fid FROM Users_old WHERE Users_old.id = Answers.user_id);

-- Step 4: Rebuild anon_attributions without FK to Users
CREATE TABLE anon_attributions_v2 (
  id         TEXT PRIMARY KEY,
  public_id  TEXT NOT NULL UNIQUE,
  author_id  INTEGER NOT NULL,
  type       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

INSERT INTO anon_attributions_v2 (id, public_id, author_id, type, created_at)
SELECT id, public_id, author_id, type, created_at
FROM anon_attributions;

DROP TABLE anon_attributions;
ALTER TABLE anon_attributions_v2 RENAME TO anon_attributions;

-- Step 5: Update author_id to fid values
UPDATE anon_attributions SET author_id = (SELECT fid FROM Users_old WHERE Users_old.id = anon_attributions.author_id);

-- Step 6: Drop old tables and stale indexes
DROP TABLE IF EXISTS Users_old;
DROP INDEX IF EXISTS idx_answers_fid;          -- from 0048, no longer needed
DROP INDEX IF EXISTS idx_anon_attributions_fid; -- from 0048, no longer needed
