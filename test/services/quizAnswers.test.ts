/**
 * Quiz answers as first-class Answers rows (docs/quizzes/CONTENT-PLAN.md §6 V1;
 * card t_b544c849).
 *
 * Against local D1 and an in-memory object store: a completion (always private
 * since 2026-09-08, docs/specs/quiz-answer-audience.md §2.2) writes
 * one sealed Private row per item in the canonical value shape, linked to the
 * completion, with answer_meta and priv_answers following; a quiz whose
 * canonical questions are not registered writes nothing and stays unmarked;
 * the backfill materialises past completions stamped with completed_at and is
 * idempotent; a materialised row re-scopes to Public through applyAnswerUpdate.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { env } from 'cloudflare:test';
import { createQuizCompletion } from '../../worker/routes/quiz-completions';
import { toCanonicalAnswer, canonicalize } from '../../worker/services/quiz/canonicalAnswers';
import { backfillQuizAnswers } from '../../worker/services/quiz/backfill';
import { applyAnswerUpdate, type ExistingAnswerRow } from '../../worker/handlers/answers/mutate';
import { openSealedAnswer } from '../../worker/handlers/answers/shared';
import { setObjectStoreForTests, type ObjectStore } from '../../worker/services/secret/SecretStore';
import { bartletQuestions } from '../../worker/services/bartlet/questions';
import { valuesQuestions } from '../../worker/services/values/questions';

const K1 = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));

class MemStore implements ObjectStore {
  objects = new Map<string, { text: string; meta?: Record<string, string> }>();
  async put(key: string, data: string, meta?: Record<string, string>) {
    this.objects.set(key, { text: data, meta });
    return { success: true, key };
  }
  async get(key: string) {
    const o = this.objects.get(key);
    return o ? { data: new TextEncoder().encode(o.text).buffer as ArrayBuffer } : null;
  }
  async delete(key: string) { return this.objects.delete(key); }
}

const vectorStub = { deleteByIds: async (ids: string[]) => ({ mutationId: 'm', count: ids.length }) };
let mem: MemStore;
const testEnv = () => ({ DB: env.DB, ANSWER_KEKS: K1, ANON_FID: '514282', QINDEX: vectorStub, AINDEX: vectorStub, AI: {} });

const FID = 42;
const B0 = bartletQuestions[0];
const B1 = bartletQuestions[1];
const B2 = bartletQuestions[2]; // never registered in these tests
const V_LIKERT = valuesQuestions.find((q) => q.type === 'likert')!;
const V_FORCED = valuesQuestions.find((q) => q.type === 'forced')!;
const V_OPEN = valuesQuestions.find((q) => q.type === 'open')!;

type AnswerRow = ExistingAnswerRow & {
  value: string; answer_type_id: string; created_at: string; primary_type: string | null;
  poll_id: string | null; quiz_completion_id: string | null;
};

async function answerRows(): Promise<AnswerRow[]> {
  const r = await env.DB.prepare('SELECT * FROM Answers ORDER BY q_id').all();
  return r.results as AnswerRow[];
}
async function completion(id: string) {
  return (await env.DB.prepare('SELECT * FROM quiz_completions WHERE id = ?').bind(id).first()) as
    { answers_materialized_at: string | null; completed_at: number };
}
async function privCount(qId: string): Promise<number> {
  const r = (await env.DB.prepare('SELECT priv_answers FROM queries WHERE id = ?').bind(qId).first()) as { priv_answers: number };
  return r.priv_answers;
}

describe('quiz answers as Answers rows', () => {
  beforeAll(async () => {
    await env.DB.batch([
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS Answers (id TEXT PRIMARY KEY, q_id TEXT NOT NULL, user_id INTEGER NOT NULL, value TEXT NOT NULL, answer_type_id TEXT NOT NULL, audience TEXT NOT NULL, created_at TEXT NOT NULL, allowlist_data TEXT, primary_type TEXT DEFAULT 'identity', reasoning TEXT, topics TEXT, answer_data TEXT, storage_ref TEXT, poll_id TEXT, quiz_completion_id TEXT)`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS queries (id TEXT PRIMARY KEY, stem TEXT, taxonomy TEXT, pub_answers INTEGER DEFAULT 0, priv_answers INTEGER DEFAULT 0)`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS answer_meta (id TEXT PRIMARY KEY, question_id TEXT NOT NULL, reply_cast_hash TEXT, replied_to_hash TEXT, responder_fid INTEGER, privacy_tier TEXT NOT NULL, storage_ref TEXT, primary_value TEXT, answer_index INTEGER, pending INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS quiz_completions (id TEXT PRIMARY KEY, quiz_id TEXT NOT NULL, user_id INTEGER NOT NULL, completed_at INTEGER NOT NULL, answers_encrypted TEXT, answers_snapshot TEXT, scores TEXT, result_category TEXT, visibility TEXT NOT NULL DEFAULT 'private', created_at INTEGER NOT NULL, answers_materialized_at TEXT)`),
    ]);
  });

  beforeEach(async () => {
    mem = new MemStore();
    setObjectStoreForTests(mem);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM Answers'),
      env.DB.prepare('DELETE FROM queries'),
      env.DB.prepare('DELETE FROM answer_meta'),
      env.DB.prepare('DELETE FROM quiz_completions'),
      env.DB.prepare(`INSERT INTO queries (id, stem, taxonomy) VALUES (?, ?, '{"primary_type":"recurring"}')`).bind(B0.id, B0.stem),
      env.DB.prepare(`INSERT INTO queries (id, stem, taxonomy) VALUES (?, ?, NULL)`).bind(B1.id, B1.stem),
      env.DB.prepare(`INSERT INTO queries (id, stem, taxonomy) VALUES (?, ?, '{"primary_type":"identity"}')`).bind(V_LIKERT.id, V_LIKERT.stem),
      env.DB.prepare(`INSERT INTO queries (id, stem, taxonomy) VALUES (?, ?, '{"primary_type":"identity"}')`).bind(V_FORCED.id, V_FORCED.stem),
      env.DB.prepare(`INSERT INTO queries (id, stem, taxonomy) VALUES (?, ?, '{"primary_type":"identity"}')`).bind(V_OPEN.id, V_OPEN.stem),
    ]);
  });
  afterAll(() => setObjectStoreForTests(null));

  it('toCanonicalAnswer maps each quiz shape onto the canonical value conventions', () => {
    expect(toCanonicalAnswer('bartlet', { queryId: B0.id, optionIndex: 1 })).toEqual({
      qId: B0.id, answerTypeId: 2, value: B0.a_options[1].label, answerData: { index: 1 },
    });
    expect(toCanonicalAnswer('values', { questionId: V_LIKERT.id, type: 'likert', position: 3 })).toEqual({
      qId: V_LIKERT.id, answerTypeId: 3, value: '4', answerData: { index: 4 },
    });
    expect(toCanonicalAnswer('values', { questionId: V_FORCED.id, type: 'forced', optionIndex: 0 })).toEqual({
      qId: V_FORCED.id, answerTypeId: 2, value: V_FORCED.a_options[0].label, answerData: { index: 0 },
    });
    expect(toCanonicalAnswer('values', { questionId: V_OPEN.id, type: 'open', text: 'to be left alone' })).toEqual({
      qId: V_OPEN.id, answerTypeId: 1, value: 'to be left alone', answerData: null,
    });
    // the bank decides the type, not the answer's own field
    expect(toCanonicalAnswer('values', { questionId: V_LIKERT.id, type: 'forced', optionIndex: 0 })).toBeNull();
    expect(toCanonicalAnswer('bartlet', { queryId: B0.id, optionIndex: 99 })).toBeNull();
    expect(toCanonicalAnswer('bartlet', { queryId: 'q_nope', optionIndex: 0 })).toBeNull();
    expect(toCanonicalAnswer('values', { questionId: V_OPEN.id, type: 'open', text: '   ' })).toBeNull();
    expect(toCanonicalAnswer('values', { queryId: 'q1', optionIndex: 2 })).toBeNull();
    expect(toCanonicalAnswer('hottakes', { questionId: 'x' })).toBeNull();
    expect(toCanonicalAnswer('bartlet', 'nope')).toBeNull();
    // every skip carries a reason the backfill report aggregates
    expect(canonicalize('hottakes', { questionId: 'x' })).toEqual({ skip: 'unknown_quiz' });
    expect(canonicalize('bartlet', 'nope')).toEqual({ skip: 'bad_shape' });
    expect(canonicalize('bartlet', { queryId: 'q_nope', optionIndex: 0 })).toEqual({ skip: 'unknown_item' });
    expect(canonicalize('bartlet', { queryId: B0.id, optionIndex: 99 })).toEqual({ skip: 'bad_index' });
    expect(canonicalize('values', { questionId: V_LIKERT.id, type: 'likert', position: 7 })).toEqual({ skip: 'bad_position' });
    expect(canonicalize('values', { questionId: V_OPEN.id, type: 'open', text: '   ' })).toEqual({ skip: 'empty_text' });
  });

  it('a private completion writes one sealed Private row per item, linked to the completion', async () => {
    const cid = await createQuizCompletion(testEnv(), {
      quizId: 'bartlet', userId: FID,
      answersJson: JSON.stringify([{ queryId: B0.id, optionIndex: 1 }, { queryId: B1.id, optionIndex: 0 }]),
      scores: {}, resultCategory: 'EXPLORER',
    });

    const rows = await answerRows();
    expect(rows).toHaveLength(2);
    const byQ = new Map(rows.map((r) => [r.q_id, r]));
    for (const r of rows) {
      expect(r.value).toBe('[encrypted]');
      expect(r.audience).toBe('Private');
      expect(r.answer_type_id).toBe('2');
      expect(r.answer_data).toBeNull();
      expect(r.storage_ref).toBe(`qstorage:answers/private/${r.id}`);
      expect(r.poll_id).toBeNull();
      expect(r.quiz_completion_id).toBe(cid);
      expect(r.user_id).toBe(FID);
    }
    // primary_type follows the question's taxonomy; a NULL taxonomy counts as identity
    expect(byQ.get(B0.id)!.primary_type).toBe('recurring');
    expect(byQ.get(B1.id)!.primary_type).toBe('identity');

    // the content is in the envelope, in the shape POST /api/answers uses, and nowhere in plaintext
    const opened = await openSealedAnswer(testEnv(), byQ.get(B0.id)!);
    expect(opened).toEqual({ value: B0.a_options[1].label, answer_data: { index: 1 }, reasoning: null });
    const stored = mem.objects.get(`answers/private/${byQ.get(B0.id)!.id}`)!;
    expect(stored.text).not.toContain(B0.a_options[1].label);
    expect(stored.meta).toMatchObject({ 'q-id': B0.id, 'user-id': '42', audience: 'Private', 'answer-type-id': '2', 'quiz-completion-id': cid });

    // bookkeeping mirrors a Private in-feed answer
    const meta = (await env.DB.prepare('SELECT * FROM answer_meta ORDER BY question_id').all()).results as Array<Record<string, unknown>>;
    expect(meta).toHaveLength(2);
    expect(meta[0]).toMatchObject({ privacy_tier: 'private', responder_fid: FID, primary_value: null, pending: 0 });
    expect(meta[0].storage_ref).toBe(byQ.get(meta[0].question_id as string)!.storage_ref);
    expect(await privCount(B0.id)).toBe(1);
    expect(await privCount(B1.id)).toBe(1);
    expect((await completion(cid)).answers_materialized_at).not.toBeNull();
  });

  it('values likert / forced / open land as scale / mc / text rows', async () => {
    await createQuizCompletion(testEnv(), {
      quizId: 'values', userId: FID,
      answersJson: JSON.stringify([
        { questionId: V_LIKERT.id, type: 'likert', position: 0 },
        { questionId: V_FORCED.id, type: 'forced', optionIndex: 1 },
        { questionId: V_OPEN.id, type: 'open', text: 'being trusted with the keys' },
      ]),
      scores: {}, resultCategory: 'autonomy', format: 'quiz',
    });
    const rows = await answerRows();
    const byQ = new Map(rows.map((r) => [r.q_id, r]));
    expect(byQ.get(V_LIKERT.id)!.answer_type_id).toBe('3');
    expect(await openSealedAnswer(testEnv(), byQ.get(V_LIKERT.id)!)).toEqual({ value: '1', answer_data: { index: 1 }, reasoning: null });
    expect(byQ.get(V_FORCED.id)!.answer_type_id).toBe('2');
    expect(await openSealedAnswer(testEnv(), byQ.get(V_FORCED.id)!)).toEqual({ value: V_FORCED.a_options[1].label, answer_data: { index: 1 }, reasoning: null });
    expect(byQ.get(V_OPEN.id)!.answer_type_id).toBe('1');
    expect(await openSealedAnswer(testEnv(), byQ.get(V_OPEN.id)!)).toEqual({ value: 'being trusted with the keys', answer_data: null, reasoning: null });
    for (const o of mem.objects.values()) expect(o.text).not.toContain('trusted with the keys');
  });

  it('an unregistered canonical question writes nothing and leaves the completion unmarked', async () => {
    const cid = await createQuizCompletion(testEnv(), {
      quizId: 'bartlet', userId: FID,
      answersJson: JSON.stringify([{ queryId: B0.id, optionIndex: 1 }, { queryId: B2.id, optionIndex: 0 }]),
      scores: {}, resultCategory: 'EXPLORER',
    });
    expect(await answerRows()).toHaveLength(0);
    expect(mem.objects.size).toBe(0);
    expect(await privCount(B0.id)).toBe(0);
    expect((await completion(cid)).answers_materialized_at).toBeNull();
  });

  it('answers with no canonical mapping are skipped and the completion is still marked', async () => {
    const cid = await createQuizCompletion(testEnv(), {
      quizId: 'values', userId: FID,
      answersJson: JSON.stringify([{ queryId: 'q1', optionIndex: 2 }]),
      scores: {}, resultCategory: 'x',
    });
    expect(await answerRows()).toHaveLength(0);
    expect((await completion(cid)).answers_materialized_at).not.toBeNull();
  });

  it('the backfill materialises past completions stamped with completed_at, and is idempotent', async () => {
    const cid = await createQuizCompletion(testEnv(), {
      quizId: 'bartlet', userId: FID,
      answersJson: JSON.stringify([{ queryId: B0.id, optionIndex: 1 }, { queryId: B1.id, optionIndex: 0 }]),
      scores: {}, resultCategory: 'EXPLORER',
    });
    // Rewind to how a completion looked before this build: no rows, no mark, an old completed_at.
    const completedAt = Date.UTC(2026, 4, 10, 12, 0, 0);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM Answers'),
      env.DB.prepare('DELETE FROM answer_meta'),
      env.DB.prepare('UPDATE queries SET priv_answers = 0'),
      env.DB.prepare('UPDATE quiz_completions SET answers_materialized_at = NULL, completed_at = ? WHERE id = ?').bind(completedAt, cid),
    ]);
    mem.objects.clear();

    const dry = await backfillQuizAnswers(testEnv(), { dryRun: true, limit: 10 });
    expect(dry).toMatchObject({ dryRun: true, processed: 1, materialized: 1, rowsWritten: 2, skippedItems: 0, skipReasons: {}, done: true, unregistered: [], errors: [] });
    expect(await answerRows()).toHaveLength(0);
    expect((await completion(cid)).answers_materialized_at).toBeNull();

    const run = await backfillQuizAnswers(testEnv(), { limit: 10 });
    expect(run).toMatchObject({ processed: 1, materialized: 1, rowsWritten: 2, done: true, unregistered: [], errors: [] });
    const rows = await answerRows();
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.created_at).toBe(new Date(completedAt).toISOString());
      expect(r.quiz_completion_id).toBe(cid);
    }
    const meta = (await env.DB.prepare('SELECT created_at FROM answer_meta').all()).results as Array<{ created_at: number }>;
    expect(meta.map((m) => m.created_at)).toEqual([completedAt, completedAt]);
    expect(await privCount(B0.id)).toBe(1);
    expect((await completion(cid)).answers_materialized_at).not.toBeNull();

    const again = await backfillQuizAnswers(testEnv(), { limit: 10 });
    expect(again).toMatchObject({ processed: 0, materialized: 0, rowsWritten: 0, done: true });
    expect(await answerRows()).toHaveLength(2);
  });

  it('the backfill reports an unregistered quiz and moves past it by cursor', async () => {
    const cid = await createQuizCompletion(testEnv(), {
      quizId: 'bartlet', userId: FID,
      answersJson: JSON.stringify([{ queryId: B2.id, optionIndex: 0 }]),
      scores: {}, resultCategory: 'EXPLORER',
    });
    const first = await backfillQuizAnswers(testEnv(), { limit: 1 });
    expect(first.processed).toBe(1);
    expect(first.materialized).toBe(0);
    expect(first.unregistered).toEqual([{ id: cid, quiz: 'bartlet', missing: [B2.id] }]);
    expect(first.done).toBe(false);
    expect(first.nextCursor).not.toBeNull();
    const second = await backfillQuizAnswers(testEnv(), { limit: 1, cursor: first.nextCursor });
    expect(second.processed).toBe(0);
    expect(second.done).toBe(true);
    expect((await completion(cid)).answers_materialized_at).toBeNull();
  });

  it('a materialised row re-scopes to Public through applyAnswerUpdate like any other', async () => {
    await createQuizCompletion(testEnv(), {
      quizId: 'bartlet', userId: FID,
      answersJson: JSON.stringify([{ queryId: B0.id, optionIndex: 1 }]),
      scores: {}, resultCategory: 'EXPLORER',
    });
    const [row] = await answerRows();
    const key = row.storage_ref!.replace('qstorage:', '');
    expect(mem.objects.has(key)).toBe(true);

    const res = await applyAnswerUpdate(testEnv(), row, {
      value: B0.a_options[1].label, audience: 'Public', answer_type_id: 2, answer_data: { index: 1 },
    });
    expect(res).toEqual({ storage: 'd1', audience: 'Public' });

    const [after] = await answerRows();
    expect(after.value).toBe(B0.a_options[1].label);
    expect(after.audience).toBe('Public');
    expect(after.storage_ref).toBeNull();
    expect(JSON.parse(after.answer_data as string)).toEqual({ index: 1 });
    expect(after.quiz_completion_id).toBe(row.quiz_completion_id);
    expect(mem.objects.has(key)).toBe(false);
    const q = (await env.DB.prepare('SELECT pub_answers, priv_answers FROM queries WHERE id = ?').bind(B0.id).first()) as { pub_answers: number; priv_answers: number };
    expect(q).toEqual({ pub_answers: 1, priv_answers: 0 });
  });
});
