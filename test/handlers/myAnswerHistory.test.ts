/**
 * GET /api/queries/:id/answers/mine: the signed-in person's whole history on a
 * question — named rows, their own Anon rows (through the sealed tag) and
 * Private rows (opened for the owner) — newest first. Nobody else's rows.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { env } from 'cloudflare:test';
import { handleListMyAnswersForQuery } from '../../worker/handlers/answers/read';
import { attributionStatement } from '../../worker/services/AnonAttributionService';
import { setObjectStoreForTests, SecretStore, type ObjectStore } from '../../worker/services/secret/SecretStore';

class MemStore implements ObjectStore {
  objects = new Map<string, string>();
  async put(key: string, data: string) { this.objects.set(key, data); return { success: true, key }; }
  async get(key: string) { const t = this.objects.get(key); return t === undefined ? null : { data: new TextEncoder().encode(t).buffer as ArrayBuffer }; }
  async delete(key: string) { return this.objects.delete(key); }
}
const b64 = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const ME = 7, OTHER = 8, ANON = 514282, Q = 'q-history', TOKEN = 'history-session';
const testEnv = { DB: env.DB, KV_USER_PROFILES: env.KV_USER_PROFILES, ANSWER_KEKS: b64(), ANON_TAG_KEY: b64(), ANON_FID: String(ANON) };

const call = async (token?: string) => {
  const res = await handleListMyAnswersForQuery(new Request(`http://x/api/queries/${Q}/answers/mine`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  }), testEnv, Q);
  return { status: res.status, body: await res.json() as { results?: Array<{ id: string; value: unknown; audience: string; poll_id: string | null }> } };
};

describe('my answer history on a question', () => {
  beforeAll(async () => {
    setObjectStoreForTests(new MemStore());
    for (const sql of [
      `CREATE TABLE IF NOT EXISTS Answers (id TEXT PRIMARY KEY, q_id TEXT NOT NULL, user_id INTEGER, value TEXT, answer_type_id TEXT, answer_data TEXT, audience TEXT, created_at TEXT, storage_ref TEXT, poll_id TEXT, quiz_completion_id TEXT)`,
      `CREATE TABLE IF NOT EXISTS anon_attributions (id TEXT PRIMARY KEY, public_id TEXT NOT NULL UNIQUE, author_id INTEGER, author_tag TEXT, author_ct TEXT, type TEXT NOT NULL, created_at TEXT NOT NULL)`,
      `INSERT OR IGNORE INTO Answers (id, q_id, user_id, value, answer_type_id, audience, created_at, poll_id, storage_ref) VALUES
         ('h1', '${Q}', ${ME}, 'first', '1', 'Public', '2026-09-01T00:00:01.000Z', 'poll-1', NULL),
         ('h2', '${Q}', ${ANON}, 'anon one', '1', 'Anon', '2026-09-02T00:00:01.000Z', NULL, NULL),
         ('h3', '${Q}', ${ME}, '[private]', '1', 'Private', '2026-09-03T00:00:01.000Z', NULL, 'qstorage:answers/private/h3'),
         ('o1', '${Q}', ${OTHER}, 'not mine', '1', 'Public', '2026-09-04T00:00:01.000Z', NULL, NULL),
         ('o2', '${Q}', ${ANON}, 'not mine either', '1', 'Anon', '2026-09-05T00:00:01.000Z', NULL, NULL),
         ('elsewhere', 'q-other', ${ME}, 'other question', '1', 'Public', '2026-09-06T00:00:01.000Z', NULL, NULL)`,
    ]) await env.DB.prepare(sql).run();
    await (await attributionStatement(testEnv, { public_id: 'h2', fid: ME, type: 'answer', scope_id: Q })).run();
    await (await attributionStatement(testEnv, { public_id: 'o2', fid: OTHER, type: 'answer', scope_id: Q })).run();
    await SecretStore.putJSON(testEnv, 'answers/private/h3', { value: 'secret thought' }, { tier: 'Private', owner: ME });
    await env.KV_USER_PROFILES.put(`session:${TOKEN}`, JSON.stringify({ fid: ME, expiresAt: Date.now() + 3_600_000 }));
  });
  afterAll(() => setObjectStoreForTests(null));

  it('returns only my rows on this question, newest first, private opened, poll kept', async () => {
    const { status, body } = await call(TOKEN);
    expect(status).toBe(200);
    expect(body.results).toEqual([
      expect.objectContaining({ id: 'h3', audience: 'Private', value: 'secret thought', poll_id: null }),
      expect.objectContaining({ id: 'h2', audience: 'Anon', value: 'anon one', poll_id: null }),
      expect.objectContaining({ id: 'h1', audience: 'Public', value: 'first', poll_id: 'poll-1' }),
    ]);
  });

  it('requires sign-in', async () => {
    expect((await call()).status).toBe(401);
  });
});
