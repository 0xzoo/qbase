/**
 * Answers API Routes
 *
 * Handles:
 * - POST /api/answers - Create a new answer
 * - POST /api/answers/:id/like - Like or unlike an answer
 * - GET /api/answers/:id - Get a single answer
 * - PUT /api/answers/:id - Update an answer
 * - GET /api/users/:fid/answers - Get user's answers
 *
 * Note: snap-derived answers are written exclusively via /snap/question/:id
 * in worker/routes/snap.ts, where the FID is parsed out of the JFS-verified
 * snap action. No public /api/answers/snap exists — see git history if you
 * need the prior shape.
 */

import { handleCreateAnswer, handleGetAnswer, handleUpdateAnswer, handleGetUserAnswers, handleListAllAnswers, handleDeleteAnswer } from '../api-bridge';
import { RateLimitService } from '../services/RateLimitService';
import { requireFlexibleAuth } from '../middleware/auth';
import { ensureUserExists } from '../middleware/userAutoCreate';
import { getMcCounts } from '../services/AnswerCountService';
type Env = any;

/**
 * Handle answer-related API routes
 */
export async function handleAnswerRoutes(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const pathname = url.pathname;

  // Answer endpoints
  if (pathname.startsWith("/api/answers")) {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const rateLimitService = RateLimitService.fromEnv(env);

    // GET /api/answers - List all answers (global feed)
    if (pathname === "/api/answers" && request.method === "GET") {
      return handleListAllAnswers(request, env);
    }

    // POST /api/answers - Create a new answer (requires auth)
    if (pathname === "/api/answers" && request.method === "POST") {
      const allowed = await rateLimitService.checkLimit(ip, 30, 60, 'answers:create');
      if (!allowed) return new Response("Too Many Requests", { status: 429 });

      // Verify authentication
      const auth = await requireFlexibleAuth(request, env);
      if (!auth.authenticated) {
        return new Response(auth.error || "Unauthorized", { status: 401 });
      }

      try {
        const body = await request.json() as Record<string, unknown>;

        // Ensure user exists in DB (auto-create if needed)
        const userRow = await ensureUserExists(env, auth.fid!);
        if (!userRow) {
          return new Response('Failed to create/retrieve user', { status: 500 });
        }

        // Inject authenticated user_id into the body (same pattern as queries)
        const verifiedBody = {
          ...body,
          user_id: userRow.id,
        };

        const verifiedRequest = new Request(request.url, {
          method: request.method,
          headers: request.headers,
          body: JSON.stringify(verifiedBody),
        });

        return handleCreateAnswer(verifiedRequest, env);
      } catch (e) {
        console.error('Error validating answer request:', e);
        return new Response('Invalid request', { status: 400 });
      }
    }

    // GET /api/answers/results/:questionId - Get MC results (grouped counts + user answer)
    // Optional: ?fid=123 to include user's answer
    const resultsMatch = pathname.match(/^\/api\/answers\/results\/([a-zA-Z0-9-]+)$/);
    if (resultsMatch && request.method === "GET") {
      const allowed = await rateLimitService.checkLimit(ip, 60, 60, 'answers:results');
      if (!allowed) return new Response("Too Many Requests", { status: 429 });

      try {
        const questionId = resultsMatch[1];
        const fidParam = url.searchParams.get('fid');

        // Get option labels
        const query = await env.DB.prepare(
          'SELECT a_options FROM queries WHERE id = ?'
        ).bind(questionId).first() as { a_options: string } | null;

        if (!query) {
          return Response.json({ error: 'Question not found' }, { status: 404 });
        }

        let options: string[] = [];
        try {
          const parsed = JSON.parse(query.a_options);
          if (Array.isArray(parsed)) options = parsed.filter(o => typeof o === 'string');
        } catch { /* ignore */ }

        // Get counts using shared CTE-based count (only latest per user)
        const { counts, total } = await getMcCounts(env.DB, questionId);

        // Check user's answer if FID provided (latest answer per user is canonical)
        let userAnswer: { option_index: number; option_label: string } | null = null;
        if (fidParam) {
          const fid = parseInt(fidParam, 10);
          if (!isNaN(fid)) {
            const answer = await env.DB.prepare(
              `SELECT value FROM Answers WHERE q_id = ? AND user_id = ? AND answer_type_id = 2
               ORDER BY created_at DESC LIMIT 1`
            ).bind(questionId, fid).first() as { value: string } | null;
            if (answer) {
              const idx = options.indexOf(answer.value);
              userAnswer = { option_index: idx >= 0 ? idx : 0, option_label: answer.value };
            }
          }
        }

        return Response.json({
          question_id: questionId,
          options,
          counts,
          total,
          user_answer: userAnswer,
        });
      } catch (error) {
        console.error('[MC Results] Error:', error);
        return Response.json({ error: 'Failed to fetch MC results' }, { status: 500 });
      }
    }

    // POST /api/answers/:id/like - Like or unlike an answer (requires auth)
    const answerLikeMatch = pathname.match(/^\/api\/answers\/([a-zA-Z0-9-]+)\/like$/);
    if (answerLikeMatch && request.method === "POST") {
      const allowed = await rateLimitService.checkLimit(ip, 60, 60, 'answers:like'); // 60 req/min
      if (!allowed) return new Response("Too Many Requests", { status: 429 });

      // Verify authentication
      const auth = await requireFlexibleAuth(request, env);
      if (!auth.authenticated || !auth.fid) {
        return new Response(auth.error || "Unauthorized", { status: 401 });
      }

      const answerId = answerLikeMatch[1];

      try {
        const body = await request.json() as {
          action: 'like' | 'unlike';
        };

        if (!body.action || !['like', 'unlike'].includes(body.action)) {
          return Response.json({ error: 'action must be "like" or "unlike"' }, { status: 400 });
        }

        // First, check if the answer exists and get its details
        // Try D1 first (for Public and Anon answers)
        const answer = await env.DB.prepare(
          `SELECT a.*, fc.cast_hash as casthash
           FROM Answers a
           LEFT JOIN farcaster_casts fc ON fc.entity_type = 'answer' AND fc.entity_id = a.id
           WHERE a.id = ?`
        ).bind(answerId).first();

        if (!answer) {
          // TODO: Support likes on privately-stored answers in the future
          return Response.json({ error: 'Answer not found or not likeable' }, { status: 404 });
        }

        // Only allow likes on Public and Anon answers
        if (answer.audience !== 'Public' && answer.audience !== 'Anon') {
          return Response.json({ error: 'Only Public and Anonymous answers can be liked' }, { status: 403 });
        }

        const userId = auth.quilAddress || String(auth.fid);
        const now = Date.now();

        if (body.action === 'like') {
          // Insert like (or ignore if already exists)
          const likeId = crypto.randomUUID();
          await env.DB.prepare(
            `INSERT INTO answer_likes (id, answer_id, user_id, created_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT (answer_id, user_id) DO NOTHING`
          ).bind(likeId, answerId, userId, now).run();
        } else {
          // Remove like (D1 only)
          await env.DB.prepare(
            `DELETE FROM answer_likes WHERE answer_id = ? AND user_id = ?`
          ).bind(answerId, userId).run();
        }

        // Get updated like count
        const countResult = await env.DB.prepare(
          `SELECT COUNT(*) as count FROM answer_likes WHERE answer_id = ?`
        ).bind(answerId).first();

        const likeCount = (countResult?.count as number) || 0;

        // Check if user has liked
        const userLikeResult = await env.DB.prepare(
          `SELECT 1 FROM answer_likes WHERE answer_id = ? AND user_id = ?`
        ).bind(answerId, userId).first();

        return Response.json({
          success: true,
          like_count: likeCount,
          user_has_liked: !!userLikeResult,
        });
      } catch (error) {
        console.error('[Answer Like] Error:', error);
        return Response.json({ error: 'Failed to process like action' }, { status: 500 });
      }
    }

    // GET /api/answers/:id - Get a single answer (public for Public audience, auth required for others)
    const answerIdMatch = pathname.match(/^\/api\/answers\/([a-zA-Z0-9-]+)$/);
    if (answerIdMatch && request.method === "GET") {
      const allowed = await rateLimitService.checkLimit(ip, 60, 60, 'answers:get'); // 60 req/min for reads
      if (!allowed) return new Response("Too Many Requests", { status: 429 });
      return handleGetAnswer(request, env, answerIdMatch[1]);
    }

    // PUT /api/answers/:id - Update an identity answer (requires auth)
    if (answerIdMatch && request.method === "PUT") {
      const allowed = await rateLimitService.checkLimit(ip, 10, 60, 'answers:update'); // 10 req/min
      if (!allowed) return new Response("Too Many Requests", { status: 429 });

      // Verify authentication
      const auth = await requireFlexibleAuth(request, env);
      if (!auth.authenticated) {
        return new Response(auth.error || "Unauthorized", { status: 401 });
      }

      return handleUpdateAnswer(request, env, answerIdMatch[1]);
    }

    // DELETE /api/answers/:id - Delete an answer (requires auth)
    if (answerIdMatch && request.method === "DELETE") {
      const auth = await requireFlexibleAuth(request, env);
      if (!auth.authenticated) {
        return new Response(auth.error || "Unauthorized", { status: 401 });
      }

      return handleDeleteAnswer(answerIdMatch[1], env, auth.fid!);
    }
  }

  // GET /api/users/:fid/answers - Get user's existing answer(s) for a specific question.
  // Public answers are visible to anyone; Private/Allowlist payloads and
  // is_own_anon attributions are only returned to the responder themselves
  // (enforced inside handleGetUserAnswers via requesterFid).
  const userAnswersMatch = pathname.match(/^\/api\/users\/(\d+)\/answers$/);
  if (userAnswersMatch && request.method === "GET") {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const rateLimitService = RateLimitService.fromEnv(env);
    const allowed = await rateLimitService.checkLimit(ip, 60, 60, 'users:answers'); // 60 req/min
    if (!allowed) return new Response("Too Many Requests", { status: 429 });

    // Auth is optional here — we still return Public answers to anonymous
    // callers — but the requester FID gates the privileged branches.
    const auth = await requireFlexibleAuth(request, env);
    const requesterFid = auth.authenticated ? auth.fid : undefined;

    return handleGetUserAnswers(request, env, userAnswersMatch[1], requesterFid);
  }

  return null;
}
/**
 * Resolve an AuthResult to a user_id string (quil_address preferred, FID fallback).
 */
