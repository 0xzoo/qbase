/**
 * Answers API Routes
 *
 * Handles:
 * - POST /api/answers/:id/like - Like or unlike an answer
 * - GET /api/answers/:id - Get a single answer
 * - PUT /api/answers/:id - Update an answer
 * - GET /api/users/:fid/answers - Get user's answers
 */

import { handleGetAnswer, handleUpdateAnswer, handleGetUserAnswers } from '../api-bridge';
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
