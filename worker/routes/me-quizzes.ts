/**
 * me-quizzes — per-user status across the three Farcaster-snap quizzes.
 *
 *   GET /api/me/quizzes  (auth required)
 *     →  { apperception: Status, values: Status, bartlet: Status }
 *
 * Each `Status` carries `{ completed, completedAt, resultCategory }`. The
 * `/quizzes` page uses this to mark cards "✓ taken" without each card having
 * to know the quirks of three different storage backends — apperception lives
 * in a KV session indexed by FID (not in `quiz_completions`), values/bartlet
 * live in `quiz_completions`. The shape collapses both behind a single fetch.
 *
 * Completed timestamp is best-effort:
 *   - apperception → KV session.createdAt + completion is "session.index ≥ LEN"
 *   - values/bartlet → `quiz_completions.completed_at` from the most recent row
 */

import { requireFlexibleAuth } from '../middleware/auth';
import { loadSessionForFid } from '../services/apperception/session';
import { APPERCEPTION_LENGTH } from '../services/apperception/questions';
import { freeTierResult } from '../services/apperception/scoring';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: CORS_HEADERS });
}

interface QuizStatus {
  completed: boolean;
  completedAt: number | null;          // unix ms — best-effort
  resultCategory: string | null;       // e.g. "BUILDER" / "openness" / "FARTNERSHIP"
}

const EMPTY: QuizStatus = { completed: false, completedAt: null, resultCategory: null };

export async function handleMeQuizzesRoutes(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/api/me/quizzes') return null;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== 'GET') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const auth = await requireFlexibleAuth(request, env);
  if (!auth.authenticated || !auth.fid) {
    return json({ error: auth.error || 'Unauthorized' }, 401);
  }
  const fid = auth.fid;

  // Fire all three lookups concurrently — they hit independent backends.
  const [apperception, values, bartlet] = await Promise.all([
    loadApperceptionStatus(env, fid),
    loadCompletionStatus(env, 'values', fid),
    loadCompletionStatus(env, 'bartlet', fid),
  ]);

  return json({ apperception, values, bartlet });
}

async function loadApperceptionStatus(env: Env, fid: number): Promise<QuizStatus> {
  try {
    const session = await loadSessionForFid(env, fid);
    if (!session) return EMPTY;
    const completed = session.index >= APPERCEPTION_LENGTH;
    if (!completed) return EMPTY;
    // Cheapest "result category" we can surface here without re-running the
    // full gated-tier pipeline. freeTierResult derives the dominant style from
    // the answer set; mirrors what the snap's result scene displays.
    let resultCategory: string | null = null;
    try {
      const free = freeTierResult(session.answers);
      resultCategory = free?.style?.style ?? null;
    } catch {
      /* free-tier scoring is pure; a throw here means malformed answers — surface "completed" anyway */
    }
    return {
      completed: true,
      completedAt: session.createdAt ?? null,
      resultCategory,
    };
  } catch (e) {
    console.warn('[me-quizzes] apperception lookup failed:', e);
    return EMPTY;
  }
}

async function loadCompletionStatus(
  env: Env,
  quizId: 'values' | 'bartlet',
  fid: number,
): Promise<QuizStatus> {
  try {
    const row = await env.DB.prepare(
      'SELECT completed_at, result_category FROM quiz_completions ' +
      'WHERE quiz_id = ? AND user_id = ? ORDER BY completed_at DESC LIMIT 1',
    ).bind(quizId, fid).first() as
      | { completed_at: number | null; result_category: string | null }
      | null;
    if (!row) return EMPTY;
    return {
      completed: true,
      completedAt: row.completed_at ?? null,
      resultCategory: row.result_category ?? null,
    };
  } catch (e) {
    console.warn(`[me-quizzes] ${quizId} lookup failed:`, e);
    return EMPTY;
  }
}
