/**
 * Anon answers never name their author on the wire — regardless of what
 * Answers.user_id holds (the snap stores the real FID with audience Anon).
 * Exercises the three public read handlers against the pool's local D1.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { handleGetAnswer, handleListAnswers, handleListAllAnswers } from '../../worker/handlers/answers/read';
import { maskAnonAuthor } from '../../worker/handlers/answers/shared';

const Q = 'q-mask';
const PUBLIC_ID = 'a-public';
const ANON_ID = 'a-anon';

describe('maskAnonAuthor', () => {
  it('strips identity from Anon rows only', () => {
    expect(maskAnonAuthor({ audience: 'Anon', user_id: 8, user_fid: 8, user_fname: 'bob', is_own_anon: true }))
      .toEqual({ audience: 'Anon', user_id: null, user_fid: null, user_fname: 'Anonymous', is_own_anon: true });
    expect(maskAnonAuthor({ audience: 'Public', user_id: 7, user_fname: 'alice' }))
      .toEqual({ audience: 'Public', user_id: 7, user_fname: 'alice' });
  });
});

describe('answer read handlers mask Anon authors (D1)', () => {
  beforeAll(async () => {
    const stmts = [
      `CREATE TABLE IF NOT EXISTS queries (id TEXT PRIMARY KEY, stem TEXT, type TEXT, scale_config TEXT)`,
      `CREATE TABLE IF NOT EXISTS users (fid INTEGER PRIMARY KEY, fname TEXT)`,
      `CREATE TABLE IF NOT EXISTS Answers (
         id TEXT PRIMARY KEY, q_id TEXT NOT NULL, user_id INTEGER, value TEXT, answer_type_id TEXT,
         answer_data TEXT, audience TEXT, created_at TEXT, storage_ref TEXT, poll_id TEXT)`,
      `CREATE TABLE IF NOT EXISTS farcaster_casts (entity_type TEXT, entity_id TEXT, cast_hash TEXT,
         cached_likes_count INTEGER, cached_recasts_count INTEGER)`,
      `CREATE TABLE IF NOT EXISTS answer_likes (id TEXT, answer_id TEXT, user_id TEXT, created_at TEXT)`,
      `INSERT OR IGNORE INTO queries (id, stem, type) VALUES ('${Q}', 'stem', 'mc')`,
      `INSERT OR IGNORE INTO users (fid, fname) VALUES (7, 'alice'), (8, 'bob')`,
      `INSERT OR IGNORE INTO Answers (id, q_id, user_id, value, answer_type_id, audience, created_at)
         VALUES ('${PUBLIC_ID}', '${Q}', 7, 'A', '2', 'Public', '2026-09-01T00:00:01.000Z'),
                ('${ANON_ID}', '${Q}', 8, 'B', '2', 'Anon', '2026-09-01T00:00:02.000Z')`,
    ];
    for (const sql of stmts) await env.DB.prepare(sql).run();
  });

  it('GET /api/queries/:id/answers never returns an Anon author', async () => {
    const res = await handleListAnswers(new Request(`http://x/api/queries/${Q}/answers?audience=Public,Anon`), env, Q);
    expect(res.status).toBe(200);
    const body = await res.json() as { results: Array<Record<string, unknown>> };
    const anon = body.results.find(r => r.id === ANON_ID)!;
    const pub = body.results.find(r => r.id === PUBLIC_ID)!;
    expect(anon).toMatchObject({ audience: 'Anon', user_id: null, user_fid: null, user_fname: 'Anonymous' });
    expect(pub).toMatchObject({ audience: 'Public', user_id: 7, user_fid: 7, user_fname: 'alice' });
  });

  it('GET /api/queries/:id/answers?unique_users=true masks too', async () => {
    const res = await handleListAnswers(new Request(`http://x/api/queries/${Q}/answers?unique_users=true`), env, Q);
    const body = await res.json() as { results: Array<Record<string, unknown>> };
    const anon = body.results.find(r => r.id === ANON_ID)!;
    expect(anon).toMatchObject({ user_id: null, user_fid: null, user_fname: 'Anonymous' });
  });

  it('GET /api/answers/:id never returns an Anon author', async () => {
    const res = await handleGetAnswer(new Request(`http://x/api/answers/${ANON_ID}`), env, ANON_ID);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({ audience: 'Anon', user_id: null, user_fid: null, user_fname: 'Anonymous' });
  });

  it('GET /api/answers (global feed) never returns an Anon author', async () => {
    const res = await handleListAllAnswers(new Request(`http://x/api/answers?audience=Public,Anon&limit=10`), env);
    expect(res.status).toBe(200);
    const body = await res.json() as { results: Array<Record<string, unknown>> };
    const anon = body.results.find(r => r.id === ANON_ID)!;
    expect(anon).toMatchObject({ user_id: null, user_fid: null, user_fname: 'Anonymous' });
  });
});
