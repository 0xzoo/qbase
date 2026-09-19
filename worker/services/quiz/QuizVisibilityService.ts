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
 * objects, Vectorize, `answer_meta` and `anon_attributions` behave identically,
 * and the one-tallied-audience rule applies per item (reported as
 * `audience_sticky` with the audience the person's other row carries,
 * docs/specs/quiz-answer-audience.md §2.4). The completion row's own
 * `visibility` is left alone: the rows are the visibility spine now, and a
 * completion stays private so an Anon choice can never be linked back
 * through the snapshot.
 *
 * An Anon row is unlinked from its completion (`quiz_completion_id` NULL,
 * `user_id` = the @4n0n placeholder) — the completion names the person, so
 * the link would be the leak. The owner still sees such rows: they are found
 * by attribution tag over the quiz's item questions and shown under the
 * person's latest completion of that quiz; a re-scope away from Anon links
 * the row to that completion again.
 */

import { applyAnswerUpdate, AudienceStickyError, type ExistingAnswerRow, type TalliedAudience } from '../../handlers/answers/mutate';
import { openSealedAnswer, parseAnswerData, storageKeyOf } from '../../handlers/answers/shared';
import { itemMeta, quizItemIds, valueLabel, type ItemKind } from './itemMeta';
import { ownAnonAnswerIds } from '../AnonAttributionService';

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

export interface ListOptions {
  /** one completion only (the result page); still scoped to the owner */
  completionId?: string;
}

export async function listMyQuizAnswers(env: Env, fid: number, opts: ListOptions = {}): Promise<MyQuizCompletion[]> {
  const one = typeof opts.completionId === 'string' && opts.completionId !== '';
  const rows = await env.DB.prepare(
    `SELECT c.id AS completion_id, c.quiz_id, c.completed_at, c.result_category, c.visibility,
            a.id, a.q_id, a.user_id, a.audience, a.value, a.answer_type_id, a.answer_data, a.storage_ref, a.created_at
     FROM quiz_completions c
     LEFT JOIN Answers a ON a.quiz_completion_id = c.id
     WHERE c.user_id = ? AND c.visibility != 'anon'${one ? ' AND c.id = ?' : ''}
     ORDER BY c.completed_at DESC, a.created_at ASC, a.q_id ASC`,
  ).bind(...(one ? [fid, opts.completionId] : [fid])).all();

  const completions = new Map<string, MyQuizCompletion>();
  const pending: Array<{ item: MyQuizAnswerItem; row: JoinedRow }> = [];

  // The person's Anon rows on each listed quiz's items, attached to their
  // newest completion of that quiz (rows in the join come newest-first).
  const anonRows: JoinedRow[] = [];
  const newestByQuiz = new Map<string, JoinedRow>();
  for (const r of (rows.results ?? []) as JoinedRow[]) {
    if (!newestByQuiz.has(r.quiz_id)) newestByQuiz.set(r.quiz_id, r);
  }
  for (const [quiz, head] of newestByQuiz) {
    const ids = await ownAnonAnswerIds(env, fid, quizItemIds(quiz));
    if (!ids.size) continue;
    const idList = [...ids];
    const found = await env.DB.prepare(
      `SELECT id, q_id, user_id, audience, value, answer_type_id, answer_data, storage_ref, created_at
       FROM Answers WHERE audience = 'Anon' AND id IN (${idList.map(() => '?').join(',')})`,
    ).bind(...idList).all();
    for (const a of (found.results ?? []) as Array<Omit<JoinedRow, 'completion_id' | 'quiz_id' | 'completed_at' | 'result_category' | 'visibility'>>) {
      anonRows.push({ ...a, completion_id: head.completion_id, quiz_id: head.quiz_id, completed_at: head.completed_at, result_category: head.result_category, visibility: head.visibility });
    }
  }

  for (const r of [...((rows.results ?? []) as JoinedRow[]), ...anonRows]) {
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

export type RescopeFailureCode = 'audience_sticky' | 'unopenable' | 'not_yours' | 'error';

export interface RescopeFailure {
  id: string;
  code: RescopeFailureCode;
  error: string;
  /** audience_sticky: what the person's other tallied row on that question carries */
  existing?: TalliedAudience;
}

export interface RescopeResult {
  changed: number;
  unchanged: number;
  failed: RescopeFailure[];
  /** final audience of every row considered, in row order */
  items: Array<{ id: string; audience: string }>;
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
    'SELECT id, quiz_id, user_id, visibility FROM quiz_completions WHERE id = ?',
  ).bind(completionId).first() as { id: string; quiz_id: string; user_id: number; visibility: string } | null;
  if (!completion) throw new RescopeError(404, 'Completion not found');
  if (Number(completion.user_id) !== fid) throw new RescopeError(403, 'Not your completion');

  const ids = Array.isArray(answerIds) ? answerIds.filter((x) => typeof x === 'string').slice(0, 100) : null;
  // The completion's rows, plus the person's Anon rows on this quiz's items
  // (unlinked from the completion while Anon; owned through the tag).
  const anonOwned = await ownAnonAnswerIds(env, fid, quizItemIds(completion.quiz_id));
  const anonList = [...anonOwned];
  const idFilter = ids && ids.length ? ` AND id IN (${ids.map(() => '?').join(',')})` : '';
  const anonWhere = anonList.length ? ` OR (audience = 'Anon' AND id IN (${anonList.map(() => '?').join(',')}))` : '';
  const rows = await env.DB.prepare(
    `SELECT * FROM Answers WHERE (quiz_completion_id = ?${anonWhere})${idFilter} ORDER BY created_at ASC`,
  ).bind(completionId, ...anonList, ...(ids && ids.length ? ids : [])).all();

  const result: RescopeResult = { changed: 0, unchanged: 0, failed: [], items: [] };
  for (const row of (rows.results ?? []) as ExistingAnswerRow[]) {
    const owned = row.audience === 'Anon' ? anonOwned.has(row.id) : Number(row.user_id) === fid;
    if (!owned) {
      result.failed.push({ id: row.id, code: 'not_yours', error: 'not yours' });
      result.items.push({ id: row.id, audience: row.audience });
      continue;
    }
    if (row.audience === audience) {
      result.unchanged++;
      result.items.push({ id: row.id, audience: row.audience });
      continue;
    }
    try {
      const content = await rowContent(env, row);
      await applyAnswerUpdate(env, row, {
        value: content.value,
        audience,
        answer_type_id: Number(row.answer_type_id as string) || 1,
        answer_data: content.answer_data,
      }, { actorFid: fid, quizCompletionId: completionId });
      result.changed++;
      result.items.push({ id: row.id, audience });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (e instanceof AudienceStickyError) {
        result.failed.push({ id: row.id, code: 'audience_sticky', error: message, existing: e.existing });
      } else {
        result.failed.push({ id: row.id, code: /would not open|sealed object missing/.test(message) ? 'unopenable' : 'error', error: message });
        console.error(`[quiz-visibility] re-scope of ${row.id} → ${audience} failed:`, e);
      }
      result.items.push({ id: row.id, audience: row.audience });
    }
  }
  return result;
}
