/**
 * Answers API Routes
 *
 * Handles:
 * - POST /api/answers - Create a new answer
 * - POST /api/answers/snap - Silent snap vote (no cast, no auth)
 * - POST /api/answers/:id/like - Like or unlike an answer
 * - GET /api/answers/:id - Get a single answer
 * - PUT /api/answers/:id - Update an answer
 * - GET /api/users/:fid/answers - Get user's answers
 */

import { handleCreateAnswer, handleGetAnswer, handleUpdateAnswer, handleGetUserAnswers, handleListAllAnswers } from '../api-bridge';
import { RateLimitService } from '../services/RateLimitService';
import { requireFlexibleAuth } from '../middleware/auth';
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
      return handleCreateAnswer(request, env);
    }

    // GET /api/answers/snap/:questionId - Get snap poll results
    // Optional: ?fid=123 to include user's vote, ?session_id=xxx for timed windows
    const snapResultsMatch = pathname.match(/^\/api\/answers\/snap\/([a-zA-Z0-9-]+)$/);
    if (snapResultsMatch && request.method === "GET") {
      const allowed = await rateLimitService.checkLimit(ip, 60, 60, 'answers:snap:results');
      if (!allowed) return new Response("Too Many Requests", { status: 429 });

      try {
        const questionId = snapResultsMatch[1];
        const fidParam = url.searchParams.get('fid');
        const sessionId = url.searchParams.get('session_id') || questionId;

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

        // Get counts per option
        const { results } = await env.DB.prepare(
          `SELECT option_index, COUNT(*) as count FROM answer_snap
           WHERE question_id = ? AND snap_session_id = ?
           GROUP BY option_index`
        ).bind(questionId, sessionId).all();

        const counts: Record<string, number> = {};
        let total = 0;
        for (const row of (results || []) as Array<{ option_index: number; count: number }>) {
          const label = options[row.option_index] ?? `option_${row.option_index}`;
          counts[label] = row.count;
          total += row.count;
        }

        // Check user's vote if FID provided
        let userVote: { option_index: number; option_label: string } | null = null;
        if (fidParam) {
          const fid = parseInt(fidParam, 10);
          if (!isNaN(fid)) {
            const vote = await env.DB.prepare(
              'SELECT option_index FROM answer_snap WHERE question_id = ? AND fid = ? AND snap_session_id = ?'
            ).bind(questionId, fid, sessionId).first() as { option_index: number } | null;
            if (vote) {
              userVote = {
                option_index: vote.option_index,
                option_label: options[vote.option_index] ?? `option_${vote.option_index}`,
              };
            }
          }
        }

        return Response.json({
          question_id: questionId,
          snap_session_id: sessionId,
          options,
          counts,
          total,
          user_vote: userVote,
        });
      } catch (error) {
        console.error('[Snap Results] Error:', error);
        return Response.json({ error: 'Failed to fetch snap results' }, { status: 500 });
      }
    }

    // POST /api/answers/snap - Silent snap vote (no cast, no auth required)
    // Body: { question_id, option_index, fid }
    // FID comes from snap session context (JFS-verified), not user auth.
    if (pathname === "/api/answers/snap" && request.method === "POST") {
      const allowed = await rateLimitService.checkLimit(ip, 30, 60, 'answers:snap');
      if (!allowed) return new Response("Too Many Requests", { status: 429 });

      try {
        const body = await request.json() as {
          question_id: string;
          option_index: number;
          fid: number;
          snap_session_id?: string;
        };

        const { question_id, option_index, fid, snap_session_id } = body;

        if (!question_id || typeof option_index !== 'number' || !fid) {
          return Response.json(
            { error: 'question_id, option_index, and fid are required' },
            { status: 400 }
          );
        }

        // Validate question exists and is select-one (mc)
        const query = await env.DB.prepare(
          'SELECT id, type FROM queries WHERE id = ?'
        ).bind(question_id).first() as { id: string; type: string } | null;

        if (!query) {
          return Response.json({ error: 'Question not found' }, { status: 404 });
        }

        if (query.type !== 'mc') {
          return Response.json({ error: 'Snap polls only support select-one (mc) questions' }, { status: 400 });
        }

        // Validate option_index is in range
        const options = await env.DB.prepare(
          'SELECT a_options FROM queries WHERE id = ?'
        ).bind(question_id).first() as { a_options: string } | null;

        if (options) {
          try {
            const parsed = JSON.parse(options.a_options);
            if (Array.isArray(parsed) && (option_index < 0 || option_index >= parsed.length)) {
              return Response.json({ error: 'option_index out of range' }, { status: 400 });
            }
          } catch { /* ignore parse error */ }
        }

        // Silent write: UPSERT to answer_snap (no cast, no answer_meta)
        const sessionId = snap_session_id || question_id; // v1: canonical session per question
        const now = new Date().toISOString();

        await env.DB.prepare(
          `INSERT INTO answer_snap (question_id, fid, option_index, snap_session_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(question_id, fid, snap_session_id) DO UPDATE SET
             option_index = excluded.option_index,
             updated_at = excluded.updated_at`
        ).bind(question_id, fid, option_index, sessionId, now, now).run();

        return Response.json({ success: true, question_id, option_index });
      } catch (error) {
        console.error('[Snap Answer] Error:', error);
        return Response.json({ error: 'Failed to record snap answer' }, { status: 500 });
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
  }

  // GET /api/users/:fid/answers - Get user's existing answer(s) for a specific question
  const userAnswersMatch = pathname.match(/^\/api\/users\/(\d+)\/answers$/);
  if (userAnswersMatch && request.method === "GET") {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const rateLimitService = RateLimitService.fromEnv(env);
    const allowed = await rateLimitService.checkLimit(ip, 60, 60, 'users:answers'); // 60 req/min
    if (!allowed) return new Response("Too Many Requests", { status: 429 });

    return handleGetUserAnswers(request, env, userAnswersMatch[1]);
  }

  return null;
}
/**
 * Resolve an AuthResult to a user_id string (quil_address preferred, FID fallback).
 */
