/**
 * The question's answer list with unique_users=true shows each person's latest
 * answer once per scope (each poll the question ran as, and the question
 * itself) — Anon answers included, now that each carries a sealed per-person
 * attribution tag. An Anon row with no attribution belongs to
 * nobody and stays on its own. The count matches the list.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { handleListAnswers } from '../../worker/handlers/answers/read';

const Q = 'q-dedup';
const ANON = 514282;

describe('answer list: latest answer per person, Anon included', () => {
  beforeAll(async () => {
    const stmts = [
      `CREATE TABLE IF NOT EXISTS queries (id TEXT PRIMARY KEY, stem TEXT, type TEXT, scale_config TEXT, a_options TEXT, taxonomy TEXT)`,
      `CREATE TABLE IF NOT EXISTS users (fid INTEGER PRIMARY KEY, fname TEXT)`,
      `CREATE TABLE IF NOT EXISTS Answers (
         id TEXT PRIMARY KEY, q_id TEXT NOT NULL, user_id INTEGER, value TEXT, answer_type_id TEXT,
         answer_data TEXT, audience TEXT, created_at TEXT, storage_ref TEXT, poll_id TEXT, quiz_completion_id TEXT)`,
      `CREATE TABLE IF NOT EXISTS anon_attributions (id TEXT PRIMARY KEY, public_id TEXT NOT NULL UNIQUE, author_id INTEGER, author_tag TEXT, author_ct TEXT, type TEXT NOT NULL, created_at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS farcaster_casts (entity_type TEXT, entity_id TEXT, cast_hash TEXT, cached_likes_count INTEGER, cached_recasts_count INTEGER)`,
      `CREATE TABLE IF NOT EXISTS answer_likes (id TEXT, answer_id TEXT, user_id TEXT, created_at TEXT)`,
      `INSERT OR IGNORE INTO queries (id, stem, type) VALUES ('${Q}', 'stem', 'mc')`,
      `INSERT OR IGNORE INTO users (fid, fname) VALUES (7, 'alice')`,
      // alice answered twice (named); person A answered anon twice; person B once; one unattributed anon row
      `INSERT OR IGNORE INTO Answers (id, q_id, user_id, value, answer_type_id, audience, created_at) VALUES
         ('n1', '${Q}', 7, '{"index":0}', '2', 'Public', '2026-09-01T00:00:01.000Z'),
         ('n2', '${Q}', 7, '{"index":1}', '2', 'Public', '2026-09-01T00:00:05.000Z'),
         ('a1', '${Q}', ${ANON}, '{"index":0}', '2', 'Anon', '2026-09-01T00:00:02.000Z'),
         ('a2', '${Q}', ${ANON}, '{"index":2}', '2', 'Anon', '2026-09-01T00:00:06.000Z'),
         ('b1', '${Q}', ${ANON}, '{"index":1}', '2', 'Anon', '2026-09-01T00:00:03.000Z'),
         ('x1', '${Q}', ${ANON}, '{"index":1}', '2', 'Anon', '2026-09-01T00:00:04.000Z')`,
      // alice and person A also voted in a poll on this question, earlier
      `INSERT OR IGNORE INTO Answers (id, q_id, user_id, value, answer_type_id, audience, created_at, poll_id) VALUES
         ('p1', '${Q}', 7, '{"index":0}', '2', 'Public', '2026-08-01T00:00:01.000Z', 'poll-1'),
         ('p2', '${Q}', ${ANON}, '{"index":0}', '2', 'Anon', '2026-08-01T00:00:02.000Z', 'poll-1'),
         ('p3', '${Q}', ${ANON}, '{"index":1}', '2', 'Anon', '2026-08-01T00:00:03.000Z', 'poll-1')`,
      `INSERT OR IGNORE INTO anon_attributions (id, public_id, author_tag, type, created_at) VALUES
         ('t1', 'a1', 'tag-A', 'answer', 'x'), ('t2', 'a2', 'tag-A', 'answer', 'x'), ('t3', 'b1', 'tag-B', 'answer', 'x'),
         ('t4', 'p2', 'tag-A', 'answer', 'x'), ('t5', 'p3', 'tag-A', 'answer', 'x')`,
    ];
    for (const sql of stmts) await env.DB.prepare(sql).run();
  });

  it('shows one row per person per scope, the latest in each', async () => {
    const res = await handleListAnswers(new Request(`http://x/api/queries/${Q}/answers?audience=Public,Anon&unique_users=true`), env, Q);
    const body = await res.json() as { results: Array<{ id: string }> };
    // question scope: n2 (alice), a2 (A), b1 (B), x1 (unattributed); poll-1: p1 (alice), p3 (A's latest there)
    expect(body.results.map(r => r.id).sort()).toEqual(['a2', 'b1', 'n2', 'p1', 'p3', 'x1']);
  });

  it('without unique_users every row is listed', async () => {
    const res = await handleListAnswers(new Request(`http://x/api/queries/${Q}/answers?audience=Public,Anon`), env, Q);
    const body = await res.json() as { results: Array<{ id: string }> };
    expect(body.results.map(r => r.id).sort()).toEqual(['a1', 'a2', 'b1', 'n1', 'n2', 'p1', 'p2', 'p3', 'x1']);
  });
});
