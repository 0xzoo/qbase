/**
 * applyAnswerUpdate — audience transitions on PUT /api/answers/:id
 * (docs/specs/private-answer-encryption.md §7.5; card t_21462509).
 *
 * Against local D1 (Answers without an updated_at column, like prod) and an
 * in-memory object store: Public → Private seals the content and clears it
 * from D1; Private → Public restores plaintext and deletes the object;
 * Private → Allowlist re-keys; a plain edit binds no updated_at and keeps
 * fields the client did not send. Since 2026-09-08 (card t_6257699d):
 * answer_meta and anon_attributions follow the row, the Vectorize entry is
 * re-added on → Public / Anon, and a change that would leave two tallied rows
 * of different audience on one question and scope is refused.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { env } from 'cloudflare:test';
import { applyAnswerUpdate, AudienceStickyError, type ExistingAnswerRow } from '../../worker/handlers/answers/mutate';
import { anon_id } from '../../src/lib/consts';
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

/** deleteByIds / upsert stubs so the Vectorize eviction and re-add on re-scope are observable. */
function vectorStub() {
  const deleted: string[] = [];
  const upserted: Array<{ id: string; values: number[]; metadata?: Record<string, unknown> }> = [];
  return {
    deleted,
    upserted,
    index: {
      deleteByIds: async (ids: string[]) => { deleted.push(...ids); return { mutationId: 'm', count: ids.length }; },
      upsert: async (vs: Array<{ id: string; values: number[]; metadata?: Record<string, unknown> }>) => { upserted.push(...vs); return { mutationId: 'm', ids: vs.map((v) => v.id) }; },
    },
  };
}
/** Workers AI stub: a fixed embedding, and the text it was asked to embed. */
const embedded: string[] = [];
const aiStub = { run: async (_model: string, input: { text: string }) => { embedded.push(input.text); return { shape: [1, 3], data: [[0.1, 0.2, 0.3]] }; } };

let mem: MemStore;
let vec: ReturnType<typeof vectorStub>;
const testEnv = () => ({ DB: env.DB, ANSWER_KEKS: K1, QINDEX: vec.index, AINDEX: vec.index, AI: aiStub });

const Q = 'q-1';
const ID = 'a-1';

async function seed(audience: string, extra: Partial<ExistingAnswerRow> = {}) {
  const value = (extra.value as string) ?? '{"index":2}';
  const sealed = audience === 'Private' || audience === 'Allowlist';
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO Answers (id, q_id, user_id, value, answer_type_id, audience, created_at, reasoning, topics, answer_data, storage_ref)
       VALUES (?, ?, 42, ?, '2', ?, '2026-09-07T00:00:00Z', ?, ?, ?, ?)`
    ).bind(
      ID, Q,
      value,
      audience,
      extra.reasoning ?? null,
      extra.topics ?? null,
      extra.answer_data ?? null,
      extra.storage_ref ?? null,
    ),
    // create.ts writes one of these per answer; the transition must keep it in step
    env.DB.prepare(
      `INSERT INTO answer_meta (id, question_id, responder_fid, privacy_tier, storage_ref, primary_value, pending, created_at)
       VALUES (?, ?, 42, ?, ?, ?, 0, 1)`
    ).bind(ID, Q, audience.toLowerCase(), extra.storage_ref ?? null, sealed ? null : value),
  ]);
}

/** Another row by the same person on the same question (the sticky rule looks at these). */
async function sibling(id: string, audience: string, opts: { poll?: string | null; createdAt?: string } = {}) {
  await env.DB.prepare(
    `INSERT INTO Answers (id, q_id, user_id, value, answer_type_id, audience, created_at, poll_id) VALUES (?, ?, 42, '{"index":1}', '2', ?, ?, ?)`
  ).bind(id, Q, audience, opts.createdAt ?? '2026-09-06T00:00:00Z', opts.poll ?? null).run();
}

async function answerRow() {
  return (await env.DB.prepare('SELECT * FROM Answers WHERE id = ?').bind(ID).first()) as ExistingAnswerRow;
}
async function counts() {
  return (await env.DB.prepare('SELECT pub_answers, priv_answers FROM queries WHERE id = ?').bind(Q).first()) as { pub_answers: number; priv_answers: number };
}
async function meta() {
  return (await env.DB.prepare('SELECT privacy_tier, storage_ref, primary_value FROM answer_meta WHERE id = ?').bind(ID).first()) as { privacy_tier: string; storage_ref: string | null; primary_value: string | null };
}
async function attributions() {
  return ((await env.DB.prepare("SELECT author_id FROM anon_attributions WHERE public_id = ? AND type = 'answer'").bind(ID).all()).results ?? []) as Array<{ author_id: number }>;
}

describe('applyAnswerUpdate', () => {
  beforeAll(async () => {
    await env.DB.batch([
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS Answers (id TEXT PRIMARY KEY, q_id TEXT, user_id INTEGER, value TEXT, answer_type_id TEXT, audience TEXT, created_at TEXT, reasoning TEXT, topics TEXT, answer_data TEXT, storage_ref TEXT, primary_type TEXT, poll_id TEXT)`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS queries (id TEXT PRIMARY KEY, stem TEXT, taxonomy TEXT, pub_answers INTEGER DEFAULT 0, priv_answers INTEGER DEFAULT 0)`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS answer_meta (id TEXT PRIMARY KEY, question_id TEXT NOT NULL, reply_cast_hash TEXT, replied_to_hash TEXT, responder_fid INTEGER, privacy_tier TEXT NOT NULL, storage_ref TEXT, primary_value TEXT, answer_index INTEGER, pending INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS anon_attributions (id TEXT PRIMARY KEY, public_id TEXT NOT NULL UNIQUE, author_id INTEGER NOT NULL, type TEXT NOT NULL, created_at TEXT NOT NULL)`),
    ]);
  });
  beforeEach(async () => {
    mem = new MemStore();
    vec = vectorStub();
    embedded.length = 0;
    setObjectStoreForTests(mem);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM Answers'),
      env.DB.prepare('DELETE FROM queries'),
      env.DB.prepare('DELETE FROM answer_meta'),
      env.DB.prepare('DELETE FROM anon_attributions'),
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
    expect(vec.upserted).toEqual([]);
    expect(await meta()).toEqual({ privacy_tier: 'private', storage_ref: 'qstorage:answers/private/a-1', primary_value: null });
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
    expect(await meta()).toEqual({ privacy_tier: 'public', storage_ref: null, primary_value: '{"index":2}' });
    // back in similarity search, with the text and metadata create.ts uses
    expect(embedded).toEqual(['Question: How many siblings? Answer: {"index":2}']);
    expect(vec.upserted).toHaveLength(1);
    expect(vec.upserted[0]).toMatchObject({ id: ID, values: [0.1, 0.2, 0.3], metadata: { q_id: Q, user_id: 42, audience: 'Public', answer_type_id: 2, created_at: '2026-09-07T00:00:00Z', primary_type: 'identity' } });
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

  it('Public → Anon keeps the row plaintext and the counts unchanged; attribution, meta and vector follow', async () => {
    await seed('Public', { answer_data: '{"index":2}' });
    const r = await applyAnswerUpdate(testEnv(), await answerRow(), { value: '{"index":2}', audience: 'Anon', answer_type_id: 2 });
    expect(r).toEqual({ storage: 'd1', audience: 'Anon' });
    expect((await answerRow()).audience).toBe('Anon');
    expect((await answerRow()).user_id).toBe(42); // the tag is the mask
    expect(await counts()).toEqual({ pub_answers: 1, priv_answers: 0 });
    expect(await attributions()).toEqual([{ author_id: 42 }]); // DELETE authorisation + "my anon answer on X" need it
    expect(await meta()).toMatchObject({ privacy_tier: 'anon', storage_ref: null, primary_value: '{"index":2}' });
    expect(vec.upserted).toHaveLength(1);
    expect(vec.upserted[0].metadata).toMatchObject({ audience: 'Anon', user_id: anon_id }); // never the real FID in the index

    // and back: the attribution goes, the entry is refreshed as Public
    await applyAnswerUpdate(testEnv(), await answerRow(), { value: '{"index":2}', audience: 'Public', answer_type_id: 2 });
    expect(await attributions()).toEqual([]);
    expect(await meta()).toMatchObject({ privacy_tier: 'public' });
    expect(vec.upserted[1].metadata).toMatchObject({ audience: 'Public', user_id: 42 });

    // Anon → Secret: attribution gone, vector evicted
    await applyAnswerUpdate(testEnv(), await answerRow(), { value: '{"index":2}', audience: 'Anon', answer_type_id: 2 });
    await applyAnswerUpdate(testEnv(), await answerRow(), { value: '{"index":2}', audience: 'Private', answer_type_id: 2 });
    expect(await attributions()).toEqual([]);
    expect(vec.deleted).toEqual([ID]);
    expect(await meta()).toMatchObject({ privacy_tier: 'private', primary_value: null });
  });

  it('one tallied audience per person, question and scope: a conflicting re-scope is refused before any write', async () => {
    await seed('Public', { answer_data: '{"index":2}' });
    await applyAnswerUpdate(testEnv(), await answerRow(), { value: '{"index":2}', audience: 'Private', answer_type_id: 2 });
    await sibling('a-2', 'Public'); // an earlier direct Public answer by the same person
    await env.DB.prepare('UPDATE queries SET pub_answers = 1, priv_answers = 1 WHERE id = ?').bind(Q).run();

    // → Anon would put a Public and an Anon row of the same person in one latest-wins tally
    const err = await applyAnswerUpdate(testEnv(), await answerRow(), { value: '{"index":2}', audience: 'Anon', answer_type_id: 2 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AudienceStickyError);
    expect((err as AudienceStickyError).existing).toBe('Public');
    expect((err as AudienceStickyError).code).toBe('audience_sticky');
    const row = await answerRow();
    expect(row.audience).toBe('Private');
    expect(row.value).toBe('[encrypted]');
    expect(mem.objects.has('answers/private/a-1')).toBe(true);
    expect(await counts()).toEqual({ pub_answers: 1, priv_answers: 1 });
    expect(await attributions()).toEqual([]);

    // → Public matches the sibling: allowed. → Secret is always allowed.
    await applyAnswerUpdate(testEnv(), await answerRow(), { value: '{"index":2}', audience: 'Public', answer_type_id: 2 });
    expect((await answerRow()).audience).toBe('Public');
    await applyAnswerUpdate(testEnv(), await answerRow(), { value: '{"index":2}', audience: 'Private', answer_type_id: 2 });
    expect((await answerRow()).audience).toBe('Private');

    // a sibling in a different scope (a wave) does not bind a direct answer
    await env.DB.prepare('DELETE FROM Answers WHERE id = ?').bind('a-2').run();
    await sibling('a-3', 'Anon', { poll: 'w1' });
    await applyAnswerUpdate(testEnv(), await answerRow(), { value: '{"index":2}', audience: 'Public', answer_type_id: 2 });
    expect((await answerRow()).audience).toBe('Public');
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
