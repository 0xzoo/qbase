/**
 * GET /api/answers/results/:id marks the signed-in viewer's own answer, taken
 * from the session. The old ?fid= probe is ignored, so nobody can look up
 * another person's answer by id; a Secret answer is never returned here.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { handleAnswerRoutes } from '../../worker/routes/answers';
import { attributionStatement } from '../../worker/services/AnonAttributionService';

const b64 = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const ME = 27, ANON_ME = 28, SECRET_ME = 29, ANON = 514282, Q = 'q-mc-viewer';
const testEnv = { DB: env.DB, KV_USER_PROFILES: env.KV_USER_PROFILES, ANSWER_KEKS: b64(), ANON_TAG_KEY: b64(), ANON_FID: String(ANON) };
const token = (fid: number) => `mc-viewer-${fid}`;

async function results(opts: { as?: number; query?: string } = {}) {
  const res = await handleAnswerRoutes(new Request(`http://x/api/answers/results/${Q}${opts.query ?? ''}`, {
    headers: { 'CF-Connecting-IP': `10.9.${opts.as ?? 0}.1`, ...(opts.as ? { Authorization: `Bearer ${token(opts.as)}` } : {}) },
  }), testEnv);
  return (await res!.json()) as { total: number; user_answer: { option_label: string } | null };
}

describe('mc results: user_answer is the viewer\'s own', () => {
  beforeAll(async () => {
    for (const sql of [
      `CREATE TABLE IF NOT EXISTS queries (id TEXT PRIMARY KEY, stem TEXT, type TEXT, a_options TEXT)`,
      `CREATE TABLE IF NOT EXISTS Answers (id TEXT PRIMARY KEY, q_id TEXT NOT NULL, user_id INTEGER, value TEXT, answer_type_id TEXT, answer_data TEXT, audience TEXT, created_at TEXT, storage_ref TEXT, poll_id TEXT, quiz_completion_id TEXT)`,
      `CREATE TABLE IF NOT EXISTS anon_attributions (id TEXT PRIMARY KEY, public_id TEXT NOT NULL UNIQUE, author_id INTEGER, author_tag TEXT, author_ct TEXT, type TEXT NOT NULL, created_at TEXT NOT NULL)`,
      `INSERT OR IGNORE INTO queries (id, stem, type, a_options) VALUES ('${Q}', 'Pick?', 'mc', '["Red","Blue"]')`,
      `INSERT OR IGNORE INTO Answers (id, q_id, user_id, value, answer_type_id, audience, created_at) VALUES
         ('m1', '${Q}', ${ME}, 'Blue', '2', 'Public', '2026-09-01T00:00:01.000Z'),
         ('m2', '${Q}', ${ANON}, 'Red', '2', 'Anon', '2026-09-02T00:00:01.000Z'),
         ('m3', '${Q}', ${SECRET_ME}, '[encrypted]', '2', 'Private', '2026-09-03T00:00:01.000Z')`,
    ]) await env.DB.prepare(sql).run();
    await (await attributionStatement(testEnv, { public_id: 'm2', fid: ANON_ME, type: 'answer', scope_id: Q })).run();
    for (const fid of [ME, ANON_ME, SECRET_ME]) {
      await env.KV_USER_PROFILES.put(`session:${token(fid)}`, JSON.stringify({ fid, expiresAt: Date.now() + 3_600_000 }));
    }
  });

  it('marks my Public answer, and my Anon one through my tag', async () => {
    expect((await results({ as: ME })).user_answer).toMatchObject({ option_label: 'Blue' });
    expect((await results({ as: ANON_ME })).user_answer).toMatchObject({ option_label: 'Red' });
  });

  it('never returns a Secret answer here', async () => {
    expect((await results({ as: SECRET_ME })).user_answer).toBeNull();
  });

  it('ignores ?fid=: signed out, nobody\'s answer comes back', async () => {
    expect((await results({ query: `?fid=${ME}` })).user_answer).toBeNull();
    expect((await results({ as: SECRET_ME, query: `?fid=${ME}` })).user_answer).toBeNull();
  });
});
