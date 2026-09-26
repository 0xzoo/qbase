/**
 * GET /api/me/answers: every non-quiz answer of the signed-in person for
 * /me/answers — named rows, their own Anon rows (through the sealed tag),
 * Secret rows opened for the owner — the latest per (question, wave) with a
 * count of the older ones. No quiz rows, nobody else's rows.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { env } from 'cloudflare:test';
import { handleMeAnswersRoutes } from '../../worker/routes/me-answers';
import { attributionStatement } from '../../worker/services/AnonAttributionService';
import { setObjectStoreForTests, SecretStore, type ObjectStore } from '../../worker/services/secret/SecretStore';

class MemStore implements ObjectStore {
  objects = new Map<string, string>();
  async put(key: string, data: string) { this.objects.set(key, data); return { success: true, key }; }
  async get(key: string) { const t = this.objects.get(key); return t === undefined ? null : { data: new TextEncoder().encode(t).buffer as ArrayBuffer }; }
  async delete(key: string) { return this.objects.delete(key); }
}
const b64 = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const ME = 17, OTHER = 18, ANON = 514282, TOKEN = 'me-answers-session';
const testEnv = { DB: env.DB, KV_USER_PROFILES: env.KV_USER_PROFILES, ANSWER_KEKS: b64(), ANON_TAG_KEY: b64(), ANON_FID: String(ANON) };

type Item = { id: string; q_id: string; stem: string; value: unknown; audience: string; poll_id: string | null; earlier: number };
const call = async (token?: string) => {
  const res = await handleMeAnswersRoutes(new Request('http://x/api/me/answers', {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  }), testEnv);
  return { status: res!.status, body: await res!.json() as { answers?: Item[] } };
};

describe('/api/me/answers', () => {
  beforeAll(async () => {
    setObjectStoreForTests(new MemStore());
    for (const sql of [
      `CREATE TABLE IF NOT EXISTS queries (id TEXT PRIMARY KEY, stem TEXT, type TEXT)`,
      `CREATE TABLE IF NOT EXISTS Answers (id TEXT PRIMARY KEY, q_id TEXT NOT NULL, user_id INTEGER, value TEXT, answer_type_id TEXT, answer_data TEXT, audience TEXT, created_at TEXT, storage_ref TEXT, poll_id TEXT, quiz_completion_id TEXT)`,
      `CREATE TABLE IF NOT EXISTS anon_attributions (id TEXT PRIMARY KEY, public_id TEXT NOT NULL UNIQUE, author_id INTEGER, author_tag TEXT, author_ct TEXT, type TEXT NOT NULL, created_at TEXT NOT NULL)`,
      `INSERT OR IGNORE INTO queries (id, stem, type) VALUES ('qa', 'Question A?', 'mc'), ('qb', 'Question B?', 'text'), ('qc', 'Question C?', 'mc'), ('qz', 'Quiz item?', 'mc')`,
      `INSERT OR IGNORE INTO Answers (id, q_id, user_id, value, answer_type_id, audience, created_at, poll_id, storage_ref, quiz_completion_id) VALUES
         ('a1', 'qa', ${ME}, 'Yes', '2', 'Public', '2026-09-01T00:00:01.000Z', NULL, NULL, NULL),
         ('a2', 'qa', ${ME}, 'No', '2', 'Public', '2026-09-02T00:00:01.000Z', NULL, NULL, NULL),
         ('a3', 'qa', ${ME}, 'Yes', '2', 'Public', '2026-09-03T00:00:01.000Z', 'wave-1', NULL, NULL),
         ('b1', 'qb', ${ME}, '[encrypted]', '1', 'Private', '2026-09-04T00:00:01.000Z', NULL, 'qstorage:answers/private/b1', NULL),
         ('c1', 'qc', ${ANON}, 'maybe', '2', 'Anon', '2026-09-05T00:00:01.000Z', NULL, NULL, NULL),
         ('c2', 'qc', ${ANON}, 'not mine', '2', 'Anon', '2026-09-06T00:00:01.000Z', NULL, NULL, NULL),
         ('o1', 'qa', ${OTHER}, 'not mine', '2', 'Public', '2026-09-07T00:00:01.000Z', NULL, NULL, NULL),
         ('z1', 'qz', ${ME}, '[encrypted]', '2', 'Private', '2026-09-08T00:00:01.000Z', NULL, NULL, 'completion-1')`,
    ]) await env.DB.prepare(sql).run();
    await (await attributionStatement(testEnv, { public_id: 'c1', fid: ME, type: 'answer', scope_id: 'qc' })).run();
    await (await attributionStatement(testEnv, { public_id: 'c2', fid: OTHER, type: 'answer', scope_id: 'qc' })).run();
    await SecretStore.putJSON(testEnv, 'answers/private/b1', { value: 'a secret' }, { tier: 'Private', owner: ME });
    await env.KV_USER_PROFILES.put(`session:${TOKEN}`, JSON.stringify({ fid: ME, expiresAt: Date.now() + 3_600_000 }));
  });
  afterAll(() => setObjectStoreForTests(null));

  it('lists my latest answer per question and wave, newest first, with older ones counted', async () => {
    const { status, body } = await call(TOKEN);
    expect(status).toBe(200);
    expect(body.answers!.map(a => [a.id, a.audience, a.value, a.poll_id, a.earlier])).toEqual([
      ['c1', 'Anon', 'maybe', null, 0],
      ['b1', 'Private', 'a secret', null, 0],
      ['a3', 'Public', 'Yes', 'wave-1', 0],
      ['a2', 'Public', 'No', null, 1],
    ]);
    expect(body.answers![0].stem).toBe('Question C?');
  });

  it('requires sign-in', async () => {
    expect((await call()).status).toBe(401);
  });
});
