/**
 * QuizVisibilityService — the owner's view of their quiz answers as rows, and
 * the per-quiz / per-answer re-scope (docs/quizzes/CONTENT-PLAN.md §6 V2;
 * card t_589c4f56).
 *
 * `listMyQuizAnswers` groups a person's `Answers` rows by the completion they
 * came from (`Answers.quiz_completion_id`, written by QuizAnswersService) and
 * opens each sealed value server-side — the only place the content is read,
 * after the ownership check the route makes. Stems and labels come from the
 * question banks (`itemMeta.ts`), not D1.
 *
 * `rescopeCompletionAnswers` moves a completion's rows (or a subset by id)
 * between Secret (`Private`), `Anon` and `Public` through `applyAnswerUpdate`
 * — the same transition every in-feed answer uses, so counters, sealed
 * objects and Vectorize eviction behave identically. The completion row's own
 * `visibility` is left alone: the rows are the visibility spine now, and a
 * completion stays private so an Anon choice can never be linked back
 * through the snapshot.
 */

import { applyAnswerUpdate, type ExistingAnswerRow } from '../../handlers/answers/mutate';
import { openSealedAnswer, parseAnswerData, storageKeyOf } from '../../handlers/answers/shared';
import { itemMeta, valueLabel, type ItemKind } from './itemMeta';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Env = any;

export type RescopeAudience = 'Private' | 'Anon' | 'Public';
export const RESCOPE_AUDIENCES: RescopeAudience[] = ['Private', 'Anon', 'Public'];

export interface MyQuizAnswerItem {
  id: string;
  q_id: string;
  stem: string;
  kind: ItemKind;
  audience: string;
  /** opened value; null when the sealed object would not open */
  value: string | null;
  label: string | null;
  answer_type_id: number;
  answer_data: Record<string, unknown> | null;
  created_at: string;
  error?: string;
}

export interface MyQuizCompletion {
  id: string;
  quiz_id: string;
  completed_at: number;
  result_category: string | null;
  /** rows exist for this completion */
  materialized: boolean;
  counts: Record<string, number>;
  items: MyQuizAnswerItem[];
}

interface JoinedRow {
  completion_id: string;
  quiz_id: string;
  completed_at: number;
  result_category: string | null;
  visibility: string;
  id: string | null;
  q_id: string | null;
  user_id: number | null;
  audience: string | null;
  value: string | null;
  answer_type_id: string | null;
  answer_data: string | null;
  storage_ref: string | null;
  created_at: string | null;
  reasoning?: string | null;
  topics?: string | null;
}

const OPEN_CONCURRENCY = 4;

async function runPool<T>(xs: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, xs.length) }, async () => {
    while (next < xs.length) await fn(xs[next++]);
  }));
}

/** The content a row holds today: opened from the envelope for a sealed row, from the row otherwise. */
async function rowContent(env: Env, row: { storage_ref?: unknown; audience?: unknown; user_id?: unknown; value?: unknown; answer_data?: unknown }):
  Promise<{ value: string; answer_data: Record<string, unknown> | null }> {
  if (storageKeyOf(row.storage_ref)) {
    const payload = await openSealedAnswer(env, row);
    if (!payload) throw new Error('sealed object missing');
    return { value: String(payload.value ?? ''), answer_data: payload.answer_data ?? null };
  }
  return { value: String(row.value ?? ''), answer_data: parseAnswerData(row.answer_data) };
}

export async function listMyQuizAnswers(env: Env, fid: number): Promise<MyQuizCompletion[]> {
  const rows = await env.DB.prepare(
    `SELECT c.id AS completion_id, c.quiz_id, c.completed_at, c.result_category, c.visibility,
            a.id, a.q_id, a.user_id, a.audience, a.value, a.answer_type_id, a.answer_data, a.storage_ref, a.created_at
     FROM quiz_completions c
     LEFT JOIN Answers a ON a.quiz_completion_id = c.id
     WHERE c.user_id = ? AND c.visibility != 'anon'
     ORDER BY c.completed_at DESC, a.created_at ASC, a.q_id ASC`,
  ).bind(fid).all();

  const completions = new Map<string, MyQuizCompletion>();
  const pending: Array<{ item: MyQuizAnswerItem; row: JoinedRow }> = [];

  for (const r of (rows.results ?? []) as JoinedRow[]) {
    let c = completions.get(r.completion_id);
    if (!c) {
      c = {
        id: r.completion_id, quiz_id: r.quiz_id, completed_at: Number(r.completed_at),
        result_category: r.result_category, materialized: false, counts: {}, items: [],
      };
      completions.set(r.completion_id, c);
    }
    if (!r.id || !r.q_id) continue;
    c.materialized = true;
    c.counts[r.audience ?? '?'] = (c.counts[r.audience ?? '?'] ?? 0) + 1;
    const meta = itemMeta(r.q_id);
    const item: MyQuizAnswerItem = {
      id: r.id, q_id: r.q_id, stem: meta?.stem ?? r.q_id, kind: meta?.kind ?? 'text',
      audience: r.audience ?? 'Private', value: null, label: null,
      answer_type_id: Number(r.answer_type_id) || 1, answer_data: null, created_at: r.created_at ?? '',
    };
    c.items.push(item);
    pending.push({ item, row: r });
  }

  await runPool(pending, OPEN_CONCURRENCY, async ({ item, row }) => {
    try {
      const content = await rowContent(env, row);
      item.value = content.value;
      item.answer_data = content.answer_data;
      const meta = itemMeta(row.q_id!);
      item.label = meta ? valueLabel(meta, content.value) : content.value;
    } catch (e) {
      item.error = e instanceof Error ? e.message : String(e);
      console.error(`[quiz-visibility] could not open answer ${item.id}:`, e);
    }
  });

  return [...completions.values()];
}

export interface RescopeResult {
  changed: number;
  unchanged: number;
  failed: Array<{ id: string; error: string }>;
}

export class RescopeError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function rescopeCompletionAnswers(
  env: Env,
  fid: number,
  completionId: string,
  audience: RescopeAudience,
  answerIds?: string[],
): Promise<RescopeResult> {
  if (!RESCOPE_AUDIENCES.includes(audience)) throw new RescopeError(400, 'audience must be Private, Anon or Public');

  const completion = await env.DB.prepare(
    'SELECT id, user_id, visibility FROM quiz_completions WHERE id = ?',
  ).bind(completionId).first() as { id: string; user_id: number; visibility: string } | null;
  if (!completion) throw new RescopeError(404, 'Completion not found');
  if (Number(completion.user_id) !== fid) throw new RescopeError(403, 'Not your completion');

  const ids = Array.isArray(answerIds) ? answerIds.filter((x) => typeof x === 'string').slice(0, 100) : null;
  const where = ids && ids.length
    ? `quiz_completion_id = ? AND id IN (${ids.map(() => '?').join(',')})`
    : 'quiz_completion_id = ?';
  const rows = await env.DB.prepare(`SELECT * FROM Answers WHERE ${where} ORDER BY created_at ASC`)
    .bind(completionId, ...(ids && ids.length ? ids : [])).all();

  const result: RescopeResult = { changed: 0, unchanged: 0, failed: [] };
  for (const row of (rows.results ?? []) as ExistingAnswerRow[]) {
    if (Number(row.user_id) !== fid) {
      result.failed.push({ id: row.id, error: 'not yours' });
      continue;
    }
    if (row.audience === audience) {
      result.unchanged++;
      continue;
    }
    try {
      const content = await rowContent(env, row);
      await applyAnswerUpdate(env, row, {
        value: content.value,
        audience,
        answer_type_id: Number(row.answer_type_id as string) || 1,
        answer_data: content.answer_data,
      });
      result.changed++;
    } catch (e) {
      result.failed.push({ id: row.id, error: e instanceof Error ? e.message : String(e) });
      console.error(`[quiz-visibility] re-scope of ${row.id} → ${audience} failed:`, e);
    }
  }
  return result;
}
