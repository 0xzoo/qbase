/**
 * admin-quiz-answers-backfill — Answers rows for past quiz completions
 * (docs/quizzes/CONTENT-PLAN.md §6 V2, data half; card t_b544c849).
 *
 * POST /api/admin/quiz-answers-backfill
 *   { dryRun?: boolean,        // plan and count, write nothing
 *     limit?: number,          // completions per call (default 25, max 100)
 *     cursor?: string,         // nextCursor from the previous response
 *     quiz?: 'bartlet' | 'values' | 'apperception' }
 *
 * Cursor-driven and idempotent; see worker/services/quiz/backfill.ts for what
 * each report field means. Repeat with the returned cursor until `done`.
 * A completion whose quiz has unregistered canonical questions is listed
 * under `unregistered` and left for a later pass (register the quiz's
 * queries first: POST /api/admin/register-<quiz>-queries).
 *
 * Auth: X-Admin-Secret header must match env.QBASE_ADMIN_SECRET.
 */

import { backfillQuizAnswers, type BackfillOpts } from '../services/quiz/backfill';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

export async function handleAdminQuizAnswersBackfill(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/api/admin/quiz-answers-backfill' || request.method !== 'POST') {
    return null;
  }
  if (request.headers.get('X-Admin-Secret') !== env.QBASE_ADMIN_SECRET) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }

  let body: BackfillOpts = {};
  try {
    body = (await request.json()) as BackfillOpts;
  } catch {
    body = {};
  }

  try {
    const report = await backfillQuizAnswers(env, {
      dryRun: !!body.dryRun,
      limit: typeof body.limit === 'number' ? body.limit : undefined,
      cursor: typeof body.cursor === 'string' ? body.cursor : null,
      quiz: typeof body.quiz === 'string' ? body.quiz : undefined,
    });
    return Response.json(report);
  } catch (e) {
    console.error('[quiz-answers-backfill] failed:', e);
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
