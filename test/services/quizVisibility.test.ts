/**
 * Retroactive visibility (docs/quizzes/CONTENT-PLAN.md §6 V2; card t_589c4f56).
 *
 * Against local D1 and an in-memory object store: the owner's listing groups
 * rows by completion with values opened and labelled; a whole quiz re-scopes
 * to Anon (plaintext on the row, object gone, counters moved) and back to
 * Secret (sealed again); a subset by id re-scopes alone; someone else's
 * completion is refused; a completion without rows lists as unmaterialised.
 * Since 2026-09-08 (card t_6257699d): one completion by id; per-item failure
 * codes, with the sticky rule refusing a row that would join a tally the
 * person is already in under another audience; the final `items` state.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { env } from 'cloudflare:test';
import { createQuizCompletion } from '../../worker/routes/quiz-completions';
import { listMyQuizAnswers, rescopeCompletionAnswers, RescopeError } from '../../worker/services/quiz/QuizVisibilityService';
import { setObjectStoreForTests, type ObjectStore } from '../../worker/services/secret/SecretStore';
import { bartletQuestions } from '../../worker/services/bartlet/questions';
import { valuesQuestions } from '../../worker/services/values/questions';

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
const vectorStub = {
  deleteByIds: async (ids: string[]) => ({ mutationId: 'm', count: ids.length }),
  upsert: async (vs: Array<{ id: string }>) => ({ mutationId: 'm', ids: vs.map((v) => v.id) }),
};
const aiStub = { run: async () => ({ shape: [1, 3], data: [[0.1, 0.2, 0.3]] }) };
let mem: MemStore;
const testEnv = () => ({ DB: env.DB, ANSWER_KEKS: K1, ANON_FID: '514282', QINDEX: vectorStub, AINDEX: vectorStub, AI: aiStub });

const FID = 42;
const B0 = bartletQuestions[0];
const B1 = bartletQuestions[1];
const B2 = bartletQuestions[2]; // not registered here
const V_LIKERT = valuesQuestions.find((q) => q.type === 'likert')!;
const V_FORCED = valuesQuestions.find((q) => q.type === 'forced')!;
const V_OPEN = valuesQuestions.find((q) => q.type === 'open')!;

async function q(id: string) {
  return (await env.DB.prepare('SELECT pub_answers, priv_answers FROM queries WHERE id = ?').bind(id).first()) as { pub_answers: number; priv_answers: number };
}

describe('quiz visibility', () => {
  beforeAll(async () => {
    await env.DB.batch([
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS Answers (id TEXT PRIMARY KEY, q_id TEXT NOT NULL, user_id INTEGER NOT NULL, value TEXT NOT NULL, answer_type_id TEXT NOT NULL, audience TEXT NOT NULL, created_at TEXT NOT NULL, allowlist_data TEXT, primary_type TEXT DEFAULT 'identity', reasoning TEXT, topics TEXT, answer_data TEXT, storage_ref TEXT, poll_id TEXT, quiz_completion_id TEXT)`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS queries (id TEXT PRIMARY KEY, stem TEXT, taxonomy TEXT, pub_answers INTEGER DEFAULT 0, priv_answers INTEGER DEFAULT 0)`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS answer_meta (id TEXT PRIMARY KEY, question_id TEXT NOT NULL, reply_cast_hash TEXT, replied_to_hash TEXT, responder_fid INTEGER, privacy_tier TEXT NOT NULL, storage_ref TEXT, primary_value TEXT, answer_index INTEGER, pending INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS quiz_completions (id TEXT PRIMARY KEY, quiz_id TEXT NOT NULL, user_id INTEGER NOT NULL, completed_at INTEGER NOT NULL, answers_encrypted TEXT, answers_snapshot TEXT, scores TEXT, result_category TEXT, visibility TEXT NOT NULL DEFAULT 'private', created_at INTEGER NOT NULL, answers_materialized_at TEXT)`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS anon_attributions (id TEXT PRIMARY KEY, public_id TEXT NOT NULL UNIQUE, author_id INTEGER NOT NULL, type TEXT NOT NULL, created_at TEXT NOT NULL)`),
    ]);
  });
  beforeEach(async () => {
    mem = new MemStore();
    setObjectStoreForTests(mem);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM Answers'), env.DB.prepare('DELETE FROM queries'),
      env.DB.prepare('DELETE FROM answer_meta'), env.DB.prepare('DELETE FROM quiz_completions'),
      env.DB.prepare('DELETE FROM anon_attributions'),
      ...[B0, B1, V_LIKERT, V_FORCED, V_OPEN].map((x) => env.DB.prepare(`INSERT INTO queries (id, stem) VALUES (?, ?)`).bind(x.id, x.stem)),
    ]);
  });
  afterAll(() => setObjectStoreForTests(null));

  async function seed() {
    const values = await createQuizCompletion(testEnv(), {
      quizId: 'values', userId: FID, scores: {}, resultCategory: 'care',
      answersJson: JSON.stringify([
        { questionId: V_LIKERT.id, type: 'likert', position: 3 },
        { questionId: V_FORCED.id, type: 'forced', optionIndex: 0 },
        { questionId: V_OPEN.id, type: 'open', text: 'to be trusted' },
      ]),
    });
    const bartlet = await createQuizCompletion(testEnv(), {
      quizId: 'bartlet', userId: FID, scores: {}, resultCategory: 'EXPLORER',
      answersJson: JSON.stringify([{ queryId: B0.id, optionIndex: 1 }, { queryId: B1.id, optionIndex: 0 }]),
    });
    return { values, bartlet };
  }

  it('lists the owner\'s completions with rows grouped, values opened and labelled', async () => {
    const { values, bartlet } = await seed();
    const list = await listMyQuizAnswers(testEnv(), FID);
    expect(list.map((c) => c.id).sort()).toEqual([values, bartlet].sort());
    const v = list.find((c) => c.id === values)!;
    expect(v).toMatchObject({ quiz_id: 'values', result_category: 'care', materialized: true, counts: { Private: 3 } });
    const byQ = new Map(v.items.map((i) => [i.q_id, i]));
    expect(byQ.get(V_LIKERT.id)).toMatchObject({ kind: 'scale', audience: 'Private', value: '4', label: 'agree', answer_type_id: 3, answer_data: { index: 4 }, stem: V_LIKERT.stem });
    expect(byQ.get(V_FORCED.id)).toMatchObject({ kind: 'mc', value: V_FORCED.a_options[0].label, label: V_FORCED.a_options[0].label, answer_type_id: 2 });
    expect(byQ.get(V_OPEN.id)).toMatchObject({ kind: 'text', value: 'to be trusted', label: 'to be trusted', answer_type_id: 1, answer_data: null });
    for (const i of v.items) expect(i.error).toBeUndefined();
    // nobody else sees anything
    expect(await listMyQuizAnswers(testEnv(), 43)).toEqual([]);
    // one completion by id (the result page), owner only
    expect((await listMyQuizAnswers(testEnv(), FID, { completionId: values })).map((c) => c.id)).toEqual([values]);
    expect(await listMyQuizAnswers(testEnv(), 43, { completionId: values })).toEqual([]);
    expect(await listMyQuizAnswers(testEnv(), FID, { completionId: 'nope' })).toEqual([]);
  });

  it('a completion whose canonical questions were not registered lists as unmaterialised', async () => {
    const id = await createQuizCompletion(testEnv(), {
      quizId: 'bartlet', userId: FID, scores: {}, resultCategory: 'x',
      answersJson: JSON.stringify([{ queryId: B2.id, optionIndex: 0 }]),
    });
    const [c] = await listMyQuizAnswers(testEnv(), FID);
    expect(c).toMatchObject({ id, materialized: false, counts: {}, items: [] });
  });

  it('re-scopes a whole quiz to Anon and back to Secret through the normal answer transition', async () => {
    const { bartlet } = await seed();
    expect(await q(B0.id)).toEqual({ pub_answers: 0, priv_answers: 1 });
    const objectsBefore = mem.objects.size;

    const toAnon = await rescopeCompletionAnswers(testEnv(), FID, bartlet, 'Anon');
    expect(toAnon).toMatchObject({ changed: 2, unchanged: 0, failed: [] });
    expect(toAnon.items.map((i) => i.audience)).toEqual(['Anon', 'Anon']);
    const rows = (await env.DB.prepare('SELECT * FROM Answers WHERE quiz_completion_id = ? ORDER BY q_id').bind(bartlet).all()).results as Array<Record<string, unknown>>;
    for (const r of rows) {
      expect(r.audience).toBe('Anon');
      expect(r.storage_ref).toBeNull();
      expect(r.user_id).toBe(FID); // the tag is the mask; the FID stays for one-vote-per-person
      expect(r.quiz_completion_id).toBe(bartlet);
      // the shadows follow the row
      expect(await env.DB.prepare('SELECT privacy_tier, storage_ref FROM answer_meta WHERE id = ?').bind(r.id).first()).toEqual({ privacy_tier: 'anon', storage_ref: null });
      expect(await env.DB.prepare("SELECT author_id FROM anon_attributions WHERE public_id = ? AND type = 'answer'").bind(r.id).first()).toEqual({ author_id: FID });
    }
    expect(rows.find((r) => r.q_id === B0.id)!.value).toBe(B0.a_options[1].label);
    expect(JSON.parse(rows.find((r) => r.q_id === B0.id)!.answer_data as string)).toEqual({ index: 1 });
    expect(mem.objects.size).toBe(objectsBefore - 2);
    expect(await q(B0.id)).toEqual({ pub_answers: 1, priv_answers: 0 });

    const again = await rescopeCompletionAnswers(testEnv(), FID, bartlet, 'Anon');
    expect(again).toMatchObject({ changed: 0, unchanged: 2, failed: [] });

    const back = await rescopeCompletionAnswers(testEnv(), FID, bartlet, 'Private');
    expect(back).toMatchObject({ changed: 2, unchanged: 0, failed: [] });
    const sealed = (await env.DB.prepare('SELECT * FROM Answers WHERE quiz_completion_id = ?').bind(bartlet).all()).results as Array<Record<string, unknown>>;
    for (const r of sealed) {
      expect(r.audience).toBe('Private');
      expect(r.value).toBe('[encrypted]');
      expect(r.storage_ref).toBe(`qstorage:answers/private/${r.id}`);
      expect(mem.objects.has(`answers/private/${r.id}`)).toBe(true);
      expect(await env.DB.prepare('SELECT privacy_tier, storage_ref, primary_value FROM answer_meta WHERE id = ?').bind(r.id).first()).toEqual({ privacy_tier: 'private', storage_ref: `qstorage:answers/private/${r.id}`, primary_value: null });
      expect(await env.DB.prepare("SELECT author_id FROM anon_attributions WHERE public_id = ?").bind(r.id).first()).toBeNull();
    }
    expect(await q(B0.id)).toEqual({ pub_answers: 0, priv_answers: 1 });

    // the listing opens the re-sealed values again
    const [c] = (await listMyQuizAnswers(testEnv(), FID)).filter((x) => x.id === bartlet);
    expect(c.items.find((i) => i.q_id === B0.id)).toMatchObject({ audience: 'Private', label: B0.a_options[1].label });
  });

  it('re-scopes a subset by id and leaves the rest alone', async () => {
    const { values } = await seed();
    const [c] = (await listMyQuizAnswers(testEnv(), FID)).filter((x) => x.id === values);
    const target = c.items.find((i) => i.q_id === V_OPEN.id)!;
    const r = await rescopeCompletionAnswers(testEnv(), FID, values, 'Public', [target.id, 'not-a-row']);
    expect(r).toMatchObject({ changed: 1, unchanged: 0, failed: [], items: [{ id: target.id, audience: 'Public' }] });
    const [after] = (await listMyQuizAnswers(testEnv(), FID)).filter((x) => x.id === values);
    expect(after.counts).toEqual({ Private: 2, Public: 1 });
    expect(after.items.find((i) => i.q_id === V_OPEN.id)).toMatchObject({ audience: 'Public', value: 'to be trusted' });
    expect(after.items.find((i) => i.q_id === V_LIKERT.id)).toMatchObject({ audience: 'Private', label: 'agree' });
  });

  it('an earlier tallied answer on the question binds the quiz row: the conflicting item is reported, the rest changes', async () => {
    const { bartlet } = await seed();
    const [c] = (await listMyQuizAnswers(testEnv(), FID)).filter((x) => x.id === bartlet);
    const rowB0 = c.items.find((i) => i.q_id === B0.id)!;
    const rowB1 = c.items.find((i) => i.q_id === B1.id)!;
    // the person answered B0 publicly on the question page a while ago
    await env.DB.prepare(
      `INSERT INTO Answers (id, q_id, user_id, value, answer_type_id, audience, created_at, poll_id) VALUES ('direct-b0', ?, ?, ?, '2', 'Public', '2026-01-01T00:00:00Z', NULL)`,
    ).bind(B0.id, FID, B0.a_options[0].label).run();

    const r = await rescopeCompletionAnswers(testEnv(), FID, bartlet, 'Anon');
    expect(r.changed).toBe(1);
    expect(r.failed).toEqual([{ id: rowB0.id, code: 'audience_sticky', error: expect.stringMatching(/publicly/), existing: 'Public' }]);
    expect(r.items).toEqual(expect.arrayContaining([{ id: rowB0.id, audience: 'Private' }, { id: rowB1.id, audience: 'Anon' }]));
    expect((await env.DB.prepare('SELECT audience, value FROM Answers WHERE id = ?').bind(rowB0.id).first())).toEqual({ audience: 'Private', value: '[encrypted]' });

    // matching the earlier answer is fine
    const pub = await rescopeCompletionAnswers(testEnv(), FID, bartlet, 'Public', [rowB0.id]);
    expect(pub).toMatchObject({ changed: 1, failed: [], items: [{ id: rowB0.id, audience: 'Public' }] });
  });

  it('refuses another person\'s completion, an unknown one, and a bad audience', async () => {
    const { bartlet } = await seed();
    await expect(rescopeCompletionAnswers(testEnv(), 43, bartlet, 'Anon')).rejects.toMatchObject({ status: 403 });
    await expect(rescopeCompletionAnswers(testEnv(), FID, 'nope', 'Anon')).rejects.toMatchObject({ status: 404 });
    await expect(rescopeCompletionAnswers(testEnv(), FID, bartlet, 'Allowlist' as never)).rejects.toBeInstanceOf(RescopeError);
    const rows = (await env.DB.prepare('SELECT audience FROM Answers WHERE quiz_completion_id = ?').bind(bartlet).all()).results as Array<{ audience: string }>;
    expect(rows.every((r) => r.audience === 'Private')).toBe(true);
  });
});
