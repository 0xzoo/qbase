/**
 * admin-quiz-stats — rebuild the cached correlation aggregate on demand
 * (worker/services/quiz/QuizStatsService.ts; card t_589c4f56).
 *
 * POST /api/admin/quiz-stats/rebuild
 *   { minGroup?: number, minCell?: number, minLift?: number }   // defaults 10 / 5 / 1.5
 *   → { built_at, users, users_per_quiz, items, findings, options }
 *
 * The 8-hourly cron (`0 0/8 * * *` in wrangler.jsonc) does the same with the
 * defaults. Auth: X-Admin-Secret.
 */

import { buildQuizStats, DEFAULT_STATS_OPTIONS } from '../services/quiz/QuizStatsService';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

export async function handleAdminQuizStats(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/api/admin/quiz-stats/rebuild' || request.method !== 'POST') return null;
  if (request.headers.get('X-Admin-Secret') !== env.QBASE_ADMIN_SECRET) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }
  let body: Partial<typeof DEFAULT_STATS_OPTIONS> = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }
  const options = {
    minGroup: Math.max(5, Number(body.minGroup) || DEFAULT_STATS_OPTIONS.minGroup),
    minCell: Math.max(3, Number(body.minCell) || DEFAULT_STATS_OPTIONS.minCell),
    minLift: Math.max(1.1, Number(body.minLift) || DEFAULT_STATS_OPTIONS.minLift),
  };
  try {
    const p = await buildQuizStats(env, options);
    return Response.json({
      built_at: p.built_at, users: p.users, users_per_quiz: p.users_per_quiz,
      items: Object.keys(p.items).length, findings: p.findings.length, options: p.options,
    });
  } catch (e) {
    console.error('[quiz-stats] rebuild failed:', e);
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
