/**
 * quiz-completions — API routes for quiz completion records.
 *
 * GET  /api/quiz-completions?user_id=FID      → list completions for a user
 * POST /api/quiz-completions/:id/reveal        → flip visibility from private → public
 *
 * Privacy model:
 *   private  → answers encrypted in Q Storage, only owner can read
 *   public   → answers plaintext in D1, anyone can read
 *   anon     → user_id is anon bot, real author in anon_attributions (future)
 *
 * Scores + result_category are always visible regardless of visibility.
 */

import { AuthService } from '../services/AuthService';

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

async function authenticateFid(
  request: Request,
  env: Env
): Promise<{ fid: number } | Response> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return json({ error: 'Missing Authorization header' }, 401);
  }
  const token = authHeader.split(' ')[1];
  const authService = AuthService.fromEnv(env, request.url);
  const result = await authService.verifyQuickAuthToken(token);
  if (!result.valid || !result.fid) {
    return json({ error: 'Invalid token' }, 401);
  }
  return { fid: result.fid };
}

export async function handleQuizCompletionRoutes(
  request: Request,
  env: Env
): Promise<Response | null> {
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // GET /api/quiz-completions?user_id=FID|me
  if (url.pathname === '/api/quiz-completions' && request.method === 'GET') {
    const userIdParam = url.searchParams.get('user_id');
    if (!userIdParam) return json({ error: 'Missing user_id parameter' }, 400);

    // Resolve "me" to authenticated FID
    let requesterFid: number | null = null;
    const authHeader = request.headers.get('Authorization');
    if (authHeader?.startsWith('Bearer ')) {
      const auth = await authenticateFid(request, env);
      if (!(auth instanceof Response)) {
        requesterFid = auth.fid;
      }
    }

    let userId: number;
    if (userIdParam === 'me') {
      if (!requesterFid) return json({ error: 'Auth required for user_id=me' }, 401);
      userId = requesterFid;
    } else {
      userId = parseInt(userIdParam, 10);
      if (isNaN(userId)) return json({ error: 'Invalid user_id' }, 400);
    }

    const isOwner = requesterFid === userId;

    // Fetch completions — owner sees all, others see public only
    const rows = isOwner
      ? await env.DB.prepare(
          'SELECT * FROM quiz_completions WHERE user_id = ? ORDER BY completed_at DESC'
        )
          .bind(userId)
          .all()
      : await env.DB.prepare(
          "SELECT * FROM quiz_completions WHERE user_id = ? AND visibility = 'public' ORDER BY completed_at DESC"
        )
          .bind(userId)
          .all();

    const completions = [];
    for (const row of rows.results ?? []) {
      const completion: Record<string, unknown> = {
        id: row.id,
        quiz_id: row.quiz_id,
        user_id: row.user_id,
        completed_at: row.completed_at,
        scores: row.scores ? JSON.parse(row.scores as string) : null,
        result_category: row.result_category,
        visibility: row.visibility,
        created_at: row.created_at,
      };

      // Include answers based on visibility + ownership
      if (row.answers_snapshot) {
        if (row.visibility === 'public') {
          completion.answers = JSON.parse(row.answers_snapshot as string);
        } else if (row.visibility === 'private' && isOwner) {
          completion.answers = JSON.parse(row.answers_snapshot as string);
        }
        // Private answers for non-owners: answers omitted
      }

      completions.push(completion);
    }

    return json({ completions });
  }

  // POST /api/quiz-completions/:id/reveal
  const revealMatch = url.pathname.match(/^\/api\/quiz-completions\/([^/]+)\/reveal$/);
  if (revealMatch && request.method === 'POST') {
    const completionId = revealMatch[1];

    const auth = await authenticateFid(request, env);
    if (auth instanceof Response) return auth;

    const row = await env.DB.prepare(
      'SELECT * FROM quiz_completions WHERE id = ?'
    )
      .bind(completionId)
      .first();

    if (!row) return json({ error: 'Completion not found' }, 404);
    if (row.user_id !== auth.fid) return json({ error: 'Forbidden' }, 403);
    if (row.visibility === 'public') {
      return json({ message: 'Already public', completion: row });
    }

    // Flip to public
    await env.DB.prepare(
      "UPDATE quiz_completions SET visibility = 'public' WHERE id = ?"
    )
      .bind(completionId)
      .run();

    return json({
      message: 'Answers revealed',
      completion: {
        id: completionId,
        visibility: 'public',
        answers: row.answers_snapshot ? JSON.parse(row.answers_snapshot as string) : null,
      },
    });
  }

  return null;
}

// ─── Helper: create a quiz completion record ──────────────────────────────

export interface CreateQuizCompletionOpts {
  quizId: string;
  userId: number;
  answersJson: string;       // JSON string of answers array
  scores: Record<string, unknown>;
  resultCategory: string;
  visibility?: 'private' | 'public' | 'anon' | 'allowlist';
  format?: string;  // 'quiz' | 'mc' | 'survey' — derives visibility if visibility not set
}

/**
 * Map quiz format to default answer visibility.
 */
export function defaultVisibilityForFormat(format: string): 'private' | 'anon' | 'allowlist' {
  switch (format) {
    case 'mc':
      return 'anon';
    case 'survey':
      return 'allowlist';
    case 'quiz':
    default:
      return 'private';
  }
}

/**
 * Persist a quiz completion: encrypt answers to Q Storage, insert D1 row.
 * Returns the completion ID.
 */
export async function createQuizCompletion(
  env: Env,
  opts: CreateQuizCompletionOpts
): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  const visibility = opts.visibility ?? defaultVisibilityForFormat(opts.format ?? 'quiz');

  // MC format: store under anon bot FID for anonymity
  let userId = opts.userId;
  if (visibility === 'anon' && opts.format === 'mc') {
    userId = Number(env.ANON_FID) || 514282;
  }

  const answersEncrypted: string | null = null;
  // TODO: encrypt to Q Storage when auth is sorted. For now, store in D1
  // regardless of visibility — access control is enforced at read time.
  const answersSnapshot: string | null = opts.answersJson;

  await env.DB.prepare(
    `INSERT INTO quiz_completions (id, quiz_id, user_id, completed_at, answers_encrypted, answers_snapshot, scores, result_category, visibility, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      opts.quizId,
      userId,
      now,
      answersEncrypted,
      answersSnapshot,
      JSON.stringify(opts.scores),
      opts.resultCategory,
      visibility,
      now
    )
    .run();

  return id;
}
