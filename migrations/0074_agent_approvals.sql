-- Migration number: 0074 	2026-09-26T00:00:00.000Z
-- Purpose: human-approved agent actions (World ID for Agents, IdP device
-- authorization grant). An agent drafts a wave; publishing it needs a fresh
-- World ID approval from the agent's owner.
--
--   agent_wave_drafts: what the agent proposes. status draft -> approved
--   (an approval was redeemed and validated) -> publishing (claimed) ->
--   published (the wave exists, poll_id) or publish_failed (publish_error).
--   Nothing but a server-side token redemption moves a draft to approved.
--
--   agent_owners: one (iss, sub) per agent. The first validated approval
--   binds it; every later approval must come from the same (iss, sub). sub is
--   pairwise per client, so it identifies the owner to qbase and nobody else.
--
--   agent_approvals: one device authorization per publish request. The
--   device_code is stored encrypted (AES-GCM, key derived from the client
--   secret), so a copy of the database alone cannot redeem it. At most one
--   pending approval per draft.
--
--   Times are unix seconds.

CREATE TABLE agent_wave_drafts (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL,
  question_id TEXT NOT NULL,
  wave        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'draft',
  created_at  INTEGER NOT NULL,
  approved_at INTEGER,
  poll_id     TEXT,
  publish_error TEXT
);

CREATE INDEX idx_agent_wave_drafts_agent ON agent_wave_drafts(agent_id);

CREATE TABLE agent_owners (
  agent_id TEXT PRIMARY KEY,
  iss      TEXT NOT NULL,
  sub      TEXT NOT NULL,
  bound_at INTEGER NOT NULL
);

CREATE TABLE agent_approvals (
  id                        TEXT PRIMARY KEY,
  draft_id                  TEXT NOT NULL,
  agent_id                  TEXT NOT NULL,
  device_code_ct            TEXT NOT NULL,
  user_code                 TEXT NOT NULL,
  verification_uri          TEXT NOT NULL,
  verification_uri_complete TEXT,
  status                    TEXT NOT NULL,
  reason                    TEXT,
  interval_s                INTEGER NOT NULL,
  next_poll_at              INTEGER NOT NULL,
  requested_at              INTEGER NOT NULL,
  expires_at                INTEGER NOT NULL,
  decided_at                INTEGER,
  iss                       TEXT,
  sub                       TEXT,
  auth_time                 INTEGER
);

CREATE INDEX idx_agent_approvals_draft ON agent_approvals(draft_id);
CREATE UNIQUE INDEX idx_agent_approvals_one_pending ON agent_approvals(draft_id) WHERE status = 'pending';
