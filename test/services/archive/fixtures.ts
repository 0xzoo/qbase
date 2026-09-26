/**
 * Local D1 schema + seed for the archive tests: one MC question, one closed
 * wave with Public, Anon and Secret answers, and one World ID verification.
 */
import { env } from 'cloudflare:test';

export const Q = '8adeb535-d682-47f6-8122-dc088a5c9221';
export const WAVE = 'wave-archive-1';
export const ACCOUNT = 1_099_511_627_776 + 7; // an account id (>= 2^40) with a linked fid

export async function createSchema() {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS Answers (id TEXT PRIMARY KEY, q_id TEXT NOT NULL, user_id INTEGER NOT NULL, value TEXT, answer_type_id TEXT, answer_data TEXT, audience TEXT, created_at TEXT, poll_id TEXT, storage_ref TEXT, reasoning TEXT, topics TEXT, quiz_completion_id TEXT)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS anon_attributions (id TEXT PRIMARY KEY, public_id TEXT NOT NULL UNIQUE, author_id INTEGER, author_tag TEXT, author_ct TEXT, type TEXT NOT NULL, created_at TEXT NOT NULL)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS queries (id TEXT PRIMARY KEY, stem TEXT, type TEXT, a_options TEXT, scale_config TEXT, created_at TEXT, coiner_fname TEXT, coiner_fid INTEGER, taxonomy TEXT, pub_answers INTEGER DEFAULT 0, priv_answers INTEGER DEFAULT 0)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS polls (id TEXT PRIMARY KEY, question_id TEXT, closes_at TEXT NOT NULL, eligibility_gate TEXT, options_config TEXT, author_fid INTEGER, cast_hash TEXT, channel_id TEXT, kind TEXT, created_at TEXT)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS Users (fid INTEGER PRIMARY KEY, fname TEXT)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS account_credentials (kind TEXT NOT NULL, value TEXT NOT NULL, account_id INTEGER NOT NULL, label TEXT, created_at INTEGER NOT NULL, last_used_at INTEGER, PRIMARY KEY (kind, value))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS world_verifications (action TEXT NOT NULL, nullifier TEXT NOT NULL, poll_id TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE (action, nullifier))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS wave_commitments (poll_id TEXT PRIMARY KEY, question_id TEXT NOT NULL, ens_name TEXT NOT NULL, status TEXT NOT NULL, bundle_json TEXT NOT NULL, bundle_sha256 TEXT NOT NULL, committed_tally TEXT NOT NULL, ar_tx TEXT, ar_error TEXT, chain_id INTEGER, tx_hash TEXT, error TEXT, attempts INTEGER NOT NULL DEFAULT 0, lease_until TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, committed_at TEXT)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS wave_chain_commits (poll_id TEXT NOT NULL, chain_id INTEGER NOT NULL, ens_name TEXT NOT NULL, tx_hash TEXT NOT NULL, committed_at TEXT NOT NULL, note TEXT, PRIMARY KEY (poll_id, chain_id))`),
  ]);
}

export async function seed(opts: { closesAt?: string } = {}) {
  const tables = ['Answers', 'anon_attributions', 'queries', 'polls', 'Users', 'account_credentials', 'world_verifications', 'wave_commitments', 'wave_chain_commits'];
  await env.DB.batch(tables.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  const ans = (id: string, user: number, value: string, audience: string, t: string, poll: string | null = WAVE) =>
    env.DB.prepare(`INSERT INTO Answers (id, q_id, user_id, value, answer_type_id, audience, created_at, poll_id) VALUES (?, ?, ?, ?, '2', ?, ?, ?)`)
      .bind(id, Q, user, value, audience, t, poll);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO queries (id, stem, type, a_options, created_at) VALUES (?, 'should corporations have the right to vote?', 'mc', '["yes","no"]', '2026-09-01T00:00:00Z')`).bind(Q),
    env.DB.prepare(`INSERT INTO polls (id, question_id, closes_at, eligibility_gate, author_fid, kind, created_at) VALUES (?, ?, ?, '{"type":"world_id","credential":"proof_of_human"}', 10215, 'measure', '2026-09-20T00:00:00Z')`)
      .bind(WAVE, Q, opts.closesAt ?? '2026-09-25T00:00:00Z'),
    env.DB.prepare(`INSERT INTO Users (fid, fname) VALUES (10215, 'zoo'), (?, 'alice'), (3, 'bob')`).bind(ACCOUNT),
    env.DB.prepare(`INSERT INTO account_credentials (kind, value, account_id, created_at) VALUES ('farcaster', '555', ?, 0)`).bind(ACCOUNT),
    env.DB.prepare(`INSERT INTO world_verifications (action, nullifier, poll_id, created_at) VALUES ('qbase-wave-${WAVE}', '123', ?, '2026-09-21T00:00:00Z')`).bind(WAVE),
    ans('a1', ACCOUNT, 'no', 'Public', '2026-09-21T00:00:00Z'),
    ans('a2', 3, 'yes', 'Public', '2026-09-21T01:00:00Z'),
    ans('a3', 3, 'no', 'Public', '2026-09-21T02:00:00Z'), // bob changes his vote: latest counts, both rows listed
    ans('a4', 514282, 'yes', 'Anon', '2026-09-21T03:00:00Z'),
    ans('a5', 9, '[encrypted]', 'Private', '2026-09-21T04:00:00Z'),
    ans('a6', 4, 'yes', 'Public', '2026-09-21T05:00:00Z', null), // direct answer, not on the wave
  ]);
}
