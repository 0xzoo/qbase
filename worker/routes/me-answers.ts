/**
 * me-answers — every answer a person has given outside quizzes, for
 * /me/answers ("your answers"). Quiz answers keep their own listing
 * (GET /api/me/quiz-answers), grouped by completion.
 *
 *   GET /api/me/answers
 *     → { answers: MyAnswer[] }  newest first, the latest per (question, wave),
 *       with `earlier` = how many older answers of yours sit behind it.
 *
 * Owner-only. Named rows are the caller's by person key; Anon rows carry the
 * @4n0n placeholder and are found through the caller's sealed author tags;
 * Secret (Private / Allowlist) values are opened for the owner here and never
 * leave this route for anyone else. Changing an answer's audience goes through
 * PUT /api/answers/:id, which keeps the sticky-audience rules.
 */

import { requireFlexibleAuth } from '../middleware/auth';
import { ownAnonAnswerIds } from '../services/AnonAttributionService';
import { openSealedAnswer } from '../handlers/answers/shared';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

export interface MyAnswer {
  id: string;
  q_id: string;
  stem: string;
  question_type: string | null;
  value: unknown;
  answer_type_id: string | number | null;
  audience: string;
  created_at: string;
  poll_id: string | null;
  earlier: number;
}

const COLS = `a.id, a.q_id, a.user_id, a.value, a.answer_type_id, a.audience, a.created_at, a.poll_id, a.storage_ref,
              q.stem, q.type AS question_type`;
const IN_CHUNK = 90;

type Row = Record<string, unknown>;

export async function listMyAnswers(env: Env, userKey: number): Promise<MyAnswer[]> {
  const named = await env.DB.prepare(
    `SELECT ${COLS} FROM Answers a JOIN queries q ON q.id = a.q_id
      WHERE a.user_id = ? AND a.quiz_completion_id IS NULL AND a.audience <> 'Anon'`,
  ).bind(userKey).all();
  const rows: Row[] = [...((named.results ?? []) as Row[])];

  // Anon rows: the questions that have any, then this person's tags on them.
  const anonQs = await env.DB.prepare(
    "SELECT DISTINCT q_id FROM Answers WHERE audience = 'Anon' AND quiz_completion_id IS NULL",
  ).all();
  let anonIds: string[] = [];
  try {
    anonIds = [...await ownAnonAnswerIds(env, userKey, ((anonQs.results ?? []) as Row[]).map(r => String(r.q_id)))];
  } catch (e) {
    console.warn('[me-answers] anon lookup unavailable:', e instanceof Error ? e.message : e);
  }
  for (let i = 0; i < anonIds.length; i += IN_CHUNK) {
    const chunk = anonIds.slice(i, i + IN_CHUNK);
    const r = await env.DB.prepare(
      `SELECT ${COLS} FROM Answers a JOIN queries q ON q.id = a.q_id
        WHERE a.id IN (${chunk.map(() => '?').join(',')}) AND a.quiz_completion_id IS NULL`,
    ).bind(...chunk).all();
    rows.push(...((r.results ?? []) as Row[]));
  }

  // Latest per (question, wave); count the older ones behind it.
  rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || String(b.id).localeCompare(String(a.id)));
  const latest = new Map<string, { row: Row; earlier: number }>();
  for (const r of rows) {
    const k = `${r.q_id}|${r.poll_id ?? ''}`;
    const seen = latest.get(k);
    if (seen) seen.earlier++;
    else latest.set(k, { row: r, earlier: 0 });
  }

  const out: MyAnswer[] = [];
  for (const { row: r, earlier } of latest.values()) {
    let value = r.value;
    if ((r.audience === 'Private' || r.audience === 'Allowlist') && r.storage_ref) {
      try {
        const payload = await openSealedAnswer(env, r);
        if (payload && payload.value !== undefined) value = payload.value;
      } catch (e) {
        console.warn(`[me-answers] could not open ${String(r.id)}:`, e instanceof Error ? e.message : e);
      }
    }
    out.push({
      id: String(r.id), q_id: String(r.q_id), stem: String(r.stem ?? ''), question_type: (r.question_type as string) ?? null,
      value, answer_type_id: (r.answer_type_id as string | number | null) ?? null, audience: String(r.audience),
      created_at: String(r.created_at), poll_id: (r.poll_id as string | null) ?? null, earlier,
    });
  }
  return out;
}

export async function handleMeAnswersRoutes(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/api/me/answers') return null;
  if (request.method !== 'GET') return Response.json({ error: 'Method not allowed' }, { status: 405 });

  const auth = await requireFlexibleAuth(request, env);
  if (!auth.authenticated || auth.userKey === undefined) {
    return Response.json({ error: 'Authentication required' }, { status: 401 });
  }
  try {
    return Response.json({ answers: await listMyAnswers(env, auth.userKey) });
  } catch (e) {
    console.error('[me-answers] failed:', e);
    return Response.json({ error: 'Failed to load your answers' }, { status: 500 });
  }
}
