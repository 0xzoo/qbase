/**
 * quiz-completions — API routes for quiz completion records.
 *
 * GET  /api/quiz-completions?user_id=FID      → list completions for a user
 *
 * Privacy model (docs/specs/private-answer-encryption.md §7.5 and
 * docs/specs/quiz-answer-audience.md §2.2): every completion is written
 * `private`, attributed to the taker, with the answers sealed under a key Q
 * holds (`answers_encrypted`, a `qenc` envelope,
 * AAD = `quiz_completions:<id>|private|<user_id>`) and `answers_snapshot`
 * NULL. Only the owner reads them, through `readCompletionAnswers`. Who else
 * sees a quiz answer is decided by the per-item `Answers` rows (below), never
 * by the completion: the reveal route that flipped a completion to `public`
 * was removed 2026-09-08 (nothing called it). `publishCompletion` remains only
 * for `POST /api/bartlet/publish` until the V3 chooser replaces that page's
 * toggle (card t_246e760c).
 *
 * Since 2026-09-07 (docs/quizzes/CONTENT-PLAN.md §6 V1) a private completion
 * also writes one Private `Answers` row per quiz item, sealed the same way
 * and linked back through `Answers.quiz_completion_id`;
 * `answers_materialized_at` records that it happened and
 * POST /api/admin/quiz-answers-backfill sweeps whatever is still NULL. See
 * worker/services/quiz/QuizAnswersService.ts.
 *
 * Scores + result_category are always visible regardless of visibility.
 */

import { AuthService } from '../services/AuthService';
import { sealForD1, openFromD1 } from '../services/secret/SecretStore';
import { materializeCompletionAnswers } from '../services/quiz/QuizAnswersService';

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

// ─── Sealed answers helpers ──────────────────────────────────────────────

export interface CompletionRow {
  id: string;
  user_id: number;
  visibility: string;
  answers_encrypted?: string | null;
  answers_snapshot?: string | null;
  [k: string]: unknown;
}

/** AAD for a completion's sealed answers: table:id, visibility at seal time, owner. */
export function completionCtx(id: string, visibility: string, userId: number | string): string {
  return `quiz_completions:${id}|${visibility}|${userId}`;
}

/**
 * The answers array of a completion, wherever it lives: the sealed column
 * (opened here, the only decrypt path for completions) or the plaintext
 * snapshot (public rows, and private rows from before the sealing build).
 * Callers check ownership first. Null when the row holds no answers.
 */
export async function readCompletionAnswers(env: Env, row: CompletionRow): Promise<unknown[] | null> {
  if (typeof row.answers_encrypted === 'string' && row.answers_encrypted !== '') {
    return openFromD1<unknown[]>(
      env,
      row.answers_encrypted,
      completionCtx(row.id, row.visibility, row.user_id),
    );
  }
  if (typeof row.answers_snapshot === 'string' && row.answers_snapshot !== '') {
    return JSON.parse(row.answers_snapshot) as unknown[];
  }
  return null;
}

/**
 * Make a completion public by choice: open the sealed answers, write them as
 * the plaintext snapshot, drop the envelope, flip visibility. Returns the
 * answers now on the public row (null when the row held none).
 *
 * @deprecated Only `POST /api/bartlet/publish` calls this; both go with the
 * V3 chooser (docs/specs/quiz-answer-audience.md §3.4, card t_246e760c).
 */
export async function publishCompletion(env: Env, row: CompletionRow): Promise<unknown[] | null> {
  const answers = await readCompletionAnswers(env, row);
  await env.DB.prepare(
    "UPDATE quiz_completions SET visibility = 'public', answers_snapshot = ?, answers_encrypted = NULL WHERE id = ?"
  )
    .bind(answers ? JSON.stringify(answers) : null, row.id)
    .run();
  return answers;
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
    for (const row of (rows.results ?? []) as CompletionRow[]) {
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

      // Answers: public rows for anyone; sealed rows for the owner only.
      if (row.visibility === 'public' || isOwner) {
        try {
          const answers = await readCompletionAnswers(env, row);
          if (answers) completion.answers = answers;
        } catch (e) {
          console.error(`[quiz-completions] could not open answers for ${row.id}:`, e);
        }
      }

      completions.push(completion);
    }

    return json({ completions });
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
}

/**
 * Persist a quiz completion: always `private`, always attributed to the
 * taker, answers sealed into `answers_encrypted` before the row is written.
 * Throws `SecretNotReadyError` (and writes nothing) when the sealing key is
 * not configured — never falls back to plaintext. Returns the completion ID.
 */
export async function createQuizCompletion(
  env: Env,
  opts: CreateQuizCompletionOpts
): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  const visibility = 'private';
  const userId = opts.userId;
  const answersEncrypted = await sealForD1(env, opts.answersJson, completionCtx(id, visibility, userId));
  const answersSnapshot: string | null = null;

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

  // Quiz answers as first-class rows (CONTENT-PLAN.md §6 V1): one Private
  // Answers row per item, sealed the same way. Best-effort — the completion
  // is the primary record; a failure is logged and the completion keeps
  // `answers_materialized_at` NULL for the backfill route to retry.
  try {
    const answers = JSON.parse(opts.answersJson) as unknown;
    if (Array.isArray(answers)) {
      const r = await materializeCompletionAnswers(env, {
        completionId: id,
        quizId: opts.quizId,
        userId,
        answers,
        createdAt: new Date(now).toISOString(),
      });
      if (!r.materialized) {
        console.warn(`[quiz-completions] ${opts.quizId} completion ${id}: answers not materialized (unregistered: ${r.missingQueries.length})`);
      }
    }
  } catch (e) {
    console.error(`[quiz-completions] materialize failed for completion ${id}:`, e);
  }

  return id;
}
