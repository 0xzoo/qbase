/**
 * bartlet-publish — publish bartlet answers as public reply casts via 4n0n.
 *
 * POST /api/bartlet/publish
 * Auth: Bearer token (QuickAuth)
 * Body: { completionId: string }
 *
 * Flow:
 * 1. Load quiz completion, verify ownership
 * 2. For each answer, look up question cast_hash from question_meta
 * 3. Post reply cast via 4n0n: "I picked <label> on the bartlet"
 * 4. Create answer_meta rows with reply_cast_hash
 * 5. Flip quiz_completions visibility to 'public'
 */

import { AuthService } from '../services/AuthService';
import { readCompletionAnswers, publishCompletion, type CompletionRow } from './quiz-completions';
import { bartletQuestions } from '../services/bartlet/questions';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: CORS_HEADERS });
}

export async function handleBartletPublish(
  request: Request,
  env: Env
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/api/bartlet/publish') return null;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  // Auth
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return json({ error: 'Auth required' }, 401);
  }
  const authService = AuthService.fromEnv(env, request.url);
  const auth = await authService.verifyQuickAuthToken(authHeader.split(' ')[1]);
  if (!auth.valid || !auth.fid) {
    return json({ error: 'Invalid token' }, 401);
  }
  const fid = auth.fid;

  // Parse body
  const body = (await request.json()) as { completionId?: string };
  if (!body.completionId) {
    return json({ error: 'completionId required' }, 400);
  }

  // Load quiz completion
  const completion = await env.DB.prepare(
    'SELECT * FROM quiz_completions WHERE id = ? AND user_id = ?'
  )
    .bind(body.completionId, fid)
    .first();

  if (!completion) {
    return json({ error: 'Completion not found' }, 404);
  }
  if (completion.visibility === 'public') {
    return json({ message: 'Already public' });
  }

  // Open the answers (sealed column, or the legacy plaintext snapshot)
  let answers: Array<{ queryId: string; optionIndex: number }>;
  try {
    const opened = await readCompletionAnswers(env, completion as CompletionRow);
    if (!opened) return json({ error: 'Completion has no answers' }, 400);
    answers = opened as Array<{ queryId: string; optionIndex: number }>;
  } catch (e) {
    console.error(`[bartlet-publish] could not open answers for ${body.completionId}:`, e);
    return json({ error: 'Could not open sealed answers' }, 500);
  }
  const questionById = new Map(bartletQuestions.map((q) => [q.id, q]));

  // 4n0n signer
  const anonKey: string | undefined = env.ANON_SIGNER_KEY;
  if (!anonKey) {
    return json({ error: 'Anon signer not configured' }, 500);
  }

  const { createHypersnapService } = await import('../services/HypersnapService');
  const hypersnap = createHypersnapService(env);

  const results: Array<{
    questionId: string;
    castHash?: string;
    error?: string;
  }> = [];

  for (const ans of answers) {
    const question = questionById.get(ans.queryId);
    if (!question) {
      results.push({ questionId: ans.queryId, error: 'unknown question' });
      continue;
    }

    // Look up question's cast_hash
    const meta = await env.DB.prepare(
      "SELECT cast_hash FROM question_meta WHERE question_id = ? AND cast_status = 'active'"
    )
      .bind(ans.queryId)
      .first();

    if (!meta?.cast_hash) {
      results.push({
        questionId: ans.queryId,
        error: 'question not cast (run admin/cast-bartlet-questions first)',
      });
      continue;
    }

    const optionLabel =
      question.a_options[ans.optionIndex]?.label ?? `option ${ans.optionIndex}`;
    const replyText = `I picked "${optionLabel}" on the bartlet`;

    try {
      const cast = await hypersnap.publishCast({
        signerKey: anonKey,
        fid: 514282, // 4n0n
        text: replyText,
        parentHash: meta.cast_hash as string,
        parentAuthorFid: 514282, // 4n0n also cast the question
      });

      // Create answer_meta row
      const answerId = crypto.randomUUID();
      const now = Date.now();
      await env.DB.prepare(
        `INSERT INTO answer_meta
           (id, question_id, reply_cast_hash, replied_to_hash,
            responder_fid, privacy_tier, answer_index, pending, created_at)
         VALUES (?, ?, ?, ?, ?, 'public', ?, 0, ?)`
      )
        .bind(
          answerId,
          ans.queryId,
          cast.hash,
          meta.cast_hash,
          fid,
          ans.optionIndex,
          now
        )
        .run();

      results.push({ questionId: ans.queryId, castHash: cast.hash });

      // Rate limit: 1s between casts
      await new Promise((r) => setTimeout(r, 1000));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({ questionId: ans.queryId, error: msg });
    }
  }

  // Flip quiz_completions to public: plaintext snapshot on the row, envelope dropped.
  await publishCompletion(env, completion as CompletionRow);

  const published = results.filter((r) => r.castHash).length;
  const errors = results.filter((r) => r.error).length;

  return json({
    ok: true,
    summary: { published, errors },
    results,
  });
}
