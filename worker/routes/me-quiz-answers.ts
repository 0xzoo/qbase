/**
 * me-quiz-answers — a person's quiz answers as rows, their visibility, and
 * their correlation report (docs/quizzes/CONTENT-PLAN.md §6 V2 + §7.9;
 * card t_589c4f56). All routes need auth; every read is scoped to the
 * caller's person key (fid before the account cutover, account id after).
 *
 *   GET  /api/me/quiz-answers[?completion_id=…]
 *        → { completions: MyQuizCompletion[] }   (values opened for the owner;
 *          one completion with the filter, 404 when it is not the caller's)
 *   POST /api/me/quiz-answers/:completionId/audience
 *        { audience: 'Private' | 'Anon' | 'Public', answer_ids?: string[] }
 *        → { changed, unchanged, failed: [{ id, code, error, existing? }], items: [{ id, audience }] }
 *          (whole quiz, or the ids given; codes: audience_sticky, unopenable, not_yours, error)
 *   GET  /api/me/quiz-report
 *        → PersonalReport                          (from the cached aggregate)
 */

import { requireFlexibleAuth } from '../middleware/auth';
import { listMyQuizAnswers, rescopeCompletionAnswers, RescopeError, type RescopeAudience } from '../services/quiz/QuizVisibilityService';
import { collectVectors, getQuizStats, personalReport } from '../services/quiz/QuizStatsService';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: CORS_HEADERS });
}

export async function handleMeQuizAnswersRoutes(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const isAnswers = url.pathname === '/api/me/quiz-answers' || url.pathname.startsWith('/api/me/quiz-answers/');
  const isReport = url.pathname === '/api/me/quiz-report';
  if (!isAnswers && !isReport) return null;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const auth = await requireFlexibleAuth(request, env);
  if (!auth.authenticated || auth.userKey === undefined) {
    return json({ error: 'Authentication required' }, 401);
  }
  // Person key: quiz_completions.user_id / Answers.user_id / anon tags are all over it.
  const userKey = auth.userKey;

  try {
    if (isReport && request.method === 'GET') {
      const [stats, mine] = await Promise.all([getQuizStats(env), collectVectors(env, userKey)]);
      return json(personalReport(stats, mine.get(userKey) ?? {}));
    }

    if (url.pathname === '/api/me/quiz-answers' && request.method === 'GET') {
      const completionId = url.searchParams.get('completion_id') ?? undefined;
      const completions = await listMyQuizAnswers(env, userKey, { completionId });
      if (completionId && completions.length === 0) return json({ error: 'Completion not found' }, 404);
      return json({ completions });
    }

    const m = url.pathname.match(/^\/api\/me\/quiz-answers\/([^/]+)\/audience$/);
    if (m && request.method === 'POST') {
      let body: { audience?: string; answer_ids?: unknown } = {};
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return json({ error: 'Invalid JSON body' }, 400);
      }
      const ids = Array.isArray(body.answer_ids) ? body.answer_ids.filter((x): x is string => typeof x === 'string') : undefined;
      try {
        const result = await rescopeCompletionAnswers(env, userKey, m[1], body.audience as RescopeAudience, ids);
        return json(result);
      } catch (e) {
        if (e instanceof RescopeError) return json({ error: e.message }, e.status);
        throw e;
      }
    }

    return json({ error: 'Method not allowed' }, 405);
  } catch (e) {
    console.error('[me-quiz-answers] failed:', e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
}
