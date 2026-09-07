/**
 * applyAnswerUpdate — audience transitions on PUT /api/answers/:id
 * (docs/specs/private-answer-encryption.md §7.5; card t_21462509).
 *
 * Against local D1 (Answers without an updated_at column, like prod) and an
 * in-memory object store: Public → Private seals the content and clears it
 * from D1; Private → Public restores plaintext and deletes the object;
 * Private → Allowlist re-keys; a plain edit binds no updated_at and keeps
 * fields the client did not send.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { env } from 'cloudflare:test';
import { applyAnswerUpdate, type ExistingAnswerRow } from '../../worker/handlers/answers/mutate';
import { setObjectStoreForTests, type ObjectStore } from '../../worker/services/secret/SecretStore';
import { isEnvelope } from '../../worker/services/secret/SecretBox';

const K1 = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));

class MemStore implements ObjectStore {
  objects = new Map<string, string>();
  async put(key: string, data: string) { this.objects.set(key, data); return { success: true, key }; }
  async get(key: string) {
    const t = this.objects.get(key);
    return t === undefined ? null : { data: new TextEncoder().encode(t).buffer as ArrayBuffer };
  }
  async delete(key: string) { return this.objects.delete(key); }
}

/** deleteByIds stub so the Vectorize eviction on re-scope is observable. */
function vectorStub() {
  const deleted: string[] = [];
  return { deleted, index: { deleteByIds: async (ids: string[]) => { deleted.push(...ids); return { mutationId: 'm', count: ids.length }; } } };
}

let mem: MemStore;
let vec: ReturnType<typeof vectorStub>;
const testEnv = () => ({ DB: env.DB, ANSWER_KEKS: K1, QINDEX: vec.index, AINDEX: vec.index, AI: {} });

const Q = 'q-1';
const ID = 'a-1';

async function seed(audience: string, extra: Partial<ExistingAnswerRow> = {}) {
  await env.DB.prepare(
    `INSERT INTO Answers (id, q_id, user_id, value, answer_type_id, audience, created_at, reasoning, topics, answer_data, storage_ref)
     VALUES (?, ?, 42, ?, '2', ?, '2026-09-07T00:00:00Z', ?, ?, ?, ?)`
  ).bind(
    ID, Q,
    (extra.value as string) ?? '{"index":2}',
    audience,
    extra.reasoning ?? null,
    extra.topics ?? null,
    extra.answer_data ?? null,
    extra.storage_ref ?? null,
  ).run();
}

async function answerRow() {
  return (await env.DB.prepare('SELECT * FROM Answers WHERE id = ?').bind(ID).first()) as ExistingAnswerRow;
}
async function counts() {
  return (await env.DB.prepare('SELECT pub_answers, priv_answers FROM queries WHERE id = ?').bind(Q).first()) as { pub_answers: number; priv_answers: number };
}

describe('applyAnswerUpdate', () => {
  beforeAll(async () => {
    await env.DB.batch([
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS Answers (id TEXT PRIMARY KEY, q_id TEXT, user_id INTEGER, value TEXT, answer_type_id TEXT, audience TEXT, created_at TEXT, reasoning TEXT, topics TEXT, answer_data TEXT, storage_ref TEXT, primary_type TEXT, poll_id TEXT)`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS queries (id TEXT PRIMARY KEY, stem TEXT, taxonomy TEXT, pub_answers INTEGER DEFAULT 0, priv_answers INTEGER DEFAULT 0)`),
    ]);
  });
  beforeEach(async () => {
    mem = new MemStore();
    vec = vectorStub();
    setObjectStoreForTests(mem);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM Answers'),
      env.DB.prepare('DELETE FROM queries'),
      env.DB.prepare(`INSERT INTO queries (id, stem, pub_answers, priv_answers) VALUES (?, 'How many siblings?', 1, 0)`).bind(Q),
    ]);
  });
  afterAll(() => setObjectStoreForTests(null));

  it('Public → Private: content sealed in the store, D1 keeps only the placeholder', async () => {
    await seed('Public', { reasoning: 'because', topics: '["family"]', answer_data: '{"index":2}' });
    const r = await applyAnswerUpdate(testEnv(), await answerRow(), { value: '{"index":2}', audience: 'Private', answer_type_id: 2 });
    expect(r).toEqual({ storage: 'qstorage', audience: 'Private' });

    const row = await answerRow();
    expect(row.value).toBe('[encrypted]');
    expect(row.audience).toBe('Private');
    expect(row.storage_ref).toBe('qstorage:answers/private/a-1');
    expect(row.reasoning).toBeNull();
    expect(row.topics).toBeNull();
    expect(row.answer_data).toBeNull(); // index is content

    const stored = mem.objects.get('answers/private/a-1')!;
    expect(isEnvelope(JSON.parse(stored))).toBe(true);
    expect(stored).not.toContain('index');
    expect(stored).not.toContain('because');
    expect(await counts()).toEqual({ pub_answers: 0, priv_answers: 1 });
    expect(vec.deleted).toEqual([ID]);
  });

  it('Private → Public: plaintext back on the row, object deleted, content recovered from the envelope', async () => {
    await seed('Public', { reasoning: 'because', answer_data: '{"index":2}' });
    await applyAnswerUpdate(testEnv(), await answerRow(), { value: '{"index":2}', audience: 'Private', answer_type_id: 2 });
    // The client sends value + audience only on a re-scope (AnswerPage.handleChangeAudience).
    const r = await applyAnswerUpdate(testEnv(), await answerRow(), { value: '{"index":2}', audience: 'Public', answer_type_id: 2 });
    expect(r).toEqual({ storage: 'd1', audience: 'Public' });

    const row = await answerRow();
    expect(row.value).toBe('{"index":2}');
    expect(row.storage_ref).toBeNull();
    expect(row.reasoning).toBe('because');
    expect(JSON.parse(row.answer_data as string)).toEqual({ index: 2 });
    expect(mem.objects.size).toBe(0);
    expect(await counts()).toEqual({ pub_answers: 1, priv_answers: 0 });
  });

  it('Private → Allowlist: new key, old object gone, only the allowlist survives in D1 answer_data', async () => {
    await seed('Public', { answer_data: '{"index":2}' });
    await applyAnswerUpdate(testEnv(), await answerRow(), { value: '{"index":2}', audience: 'Private', answer_type_id: 2 });
    await applyAnswerUpdate(testEnv(), await answerRow(), { value: '{"index":2}', audience: 'Allowlist', answer_type_id: 2, allowlist: [7, 8] });

    const row = await answerRow();
    expect(row.audience).toBe('Allowlist');
    expect(row.storage_ref).toBe('qstorage:answers/allowlist/a-1');
    expect(JSON.parse(row.answer_data as string)).toEqual({ allowlist: [7, 8] });
    expect(mem.objects.has('answers/private/a-1')).toBe(false);
    expect(mem.objects.has('answers/allowlist/a-1')).toBe(true);
    expect(await counts()).toEqual({ pub_answers: 0, priv_answers: 1 });

    // Back to public: the allowlist ride-along and the index both come back.
    await applyAnswerUpdate(testEnv(), await answerRow(), { value: '{"index":2}', audience: 'Public', answer_type_id: 2 });
    expect(JSON.parse((await answerRow()).answer_data as string)).toEqual({ index: 2, allowlist: [7, 8] });
  });

  it('a plain Public edit works without updated_at and keeps fields the client did not send', async () => {
    await seed('Public', { reasoning: 'because', topics: '["family"]', answer_data: '{"index":2}' });
    await applyAnswerUpdate(testEnv(), await answerRow(), { value: '{"index":3}', audience: 'Public', answer_type_id: 2, answer_data: { index: 3 } });
    const row = await answerRow();
    expect(row.value).toBe('{"index":3}');
    expect(row.reasoning).toBe('because');
    expect(row.topics).toBe('["family"]');
    expect(JSON.parse(row.answer_data as string)).toEqual({ index: 3 });
    expect(await counts()).toEqual({ pub_answers: 1, priv_answers: 0 });
    expect(mem.objects.size).toBe(0);
  });

  it('Public → Anon keeps the row plaintext and the counts unchanged', async () => {
    await seed('Public', { answer_data: '{"index":2}' });
    const r = await applyAnswerUpdate(testEnv(), await answerRow(), { value: '{"index":2}', audience: 'Anon', answer_type_id: 2 });
    expect(r).toEqual({ storage: 'd1', audience: 'Anon' });
    expect((await answerRow()).audience).toBe('Anon');
    expect(await counts()).toEqual({ pub_answers: 1, priv_answers: 0 });
  });

  it('a sealed row whose object will not open is refused: nothing re-scoped, nothing deleted', async () => {
    await seed('Private', { storage_ref: 'qstorage:answers/private/a-1' });
    await env.DB.prepare('UPDATE queries SET pub_answers = 0, priv_answers = 1 WHERE id = ?').bind(Q).run();
    // Plaintext in the store is an error after the migration (SecretStore.LEGACY_PLAINTEXT_TOLERATED = false).
    mem.objects.set('answers/private/a-1', JSON.stringify({ value: '{"index":2}', answer_data: null, reasoning: 'r' }));
    await expect(applyAnswerUpdate(testEnv(), await answerRow(), { value: '{"index":2}', audience: 'Public', answer_type_id: 2 }))
      .rejects.toThrow(/would not open/);
    const row = await answerRow();
    expect(row.audience).toBe('Private');
    expect(row.value).toBe('{"index":2}');
    expect(mem.objects.has('answers/private/a-1')).toBe(true);
    expect(await counts()).toEqual({ pub_answers: 0, priv_answers: 1 });
  });

  it('a sealed row whose object is missing still re-scopes from what D1 holds', async () => {
    await seed('Private', { storage_ref: 'qstorage:answers/private/a-1', answer_data: '{"allowlist":[7]}' });
    await env.DB.prepare('UPDATE queries SET pub_answers = 0, priv_answers = 1 WHERE id = ?').bind(Q).run();
    await applyAnswerUpdate(testEnv(), await answerRow(), { value: '{"index":2}', audience: 'Public', answer_type_id: 2 });
    const row = await answerRow();
    expect(row.audience).toBe('Public');
    expect(row.storage_ref).toBeNull();
    expect(JSON.parse(row.answer_data as string)).toEqual({ allowlist: [7] });
    expect(await counts()).toEqual({ pub_answers: 1, priv_answers: 0 });
  });
});
