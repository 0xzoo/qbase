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

import { handleCreateAnswer, handleGetAnswer, handleUpdateAnswer, handleGetUserAnswers, handleListAllAnswers, handleDeleteAnswer } from '../handlers/answers';
import { RateLimitService } from '../services/RateLimitService';
import { requireFlexibleAuth, getOptionalUserKey } from '../middleware/auth';
import { anonTagReady } from '../services/anon/AnonTag';
import { authorTags } from '../services/AnonAttributionService';
import { ensureUserExists } from '../middleware/userAutoCreate';
import { getMcCounts } from '../services/AnswerCountService';
import { parseOptionsConfig, listVisibleOptions } from '../services/PollOptionsService';
import { likeIdentitiesForAuth } from '../handlers/answers/read';
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
      if (!auth.authenticated || auth.userKey === undefined) {
        return new Response(auth.error || "Unauthorized", { status: 401 });
      }

      try {
        const body = await request.json() as Record<string, unknown>;

        // A Farcaster sign-in: ensure the profile row exists (auto-create /
        // refresh from Farcaster). An account without a fid already has its
        // profile row (created with the account); answering never needs Farcaster.
        if (auth.fid !== undefined) {
          const userRow = await ensureUserExists(env, auth.fid);
          if (!userRow) {
            return new Response('Failed to create/retrieve user', { status: 500 });
          }
        }

        // Inject the authenticated person key as user_id (same pattern as queries)
        const verifiedBody = {
          ...body,
          user_id: auth.userKey,
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
    // user_answer is the signed-in viewer's own latest answer, taken from the
    // session. No id in the URL: nobody can look up someone else's answer here.
    const resultsMatch = pathname.match(/^\/api\/answers\/results\/([a-zA-Z0-9_-]+)$/);
    if (resultsMatch && request.method === "GET") {
      const allowed = await rateLimitService.checkLimit(ip, 60, 60, 'answers:results');
      if (!allowed) return new Response("Too Many Requests", { status: 429 });

      try {
        const questionId = resultsMatch[1];
        // ?poll=<id> scopes the tally to one wave (latest per (wave, user)).
        const pollParam = url.searchParams.get('poll');
        let pollId: string | null = null;
        let pollRow: import('../services/PollService').PollRow | null = null;
        if (pollParam) {
          const { getPoll } = await import('../services/PollService');
          const poll = await getPoll(env.DB, pollParam);
          if (!poll) return Response.json({ error: 'Poll not found' }, { status: 404 });
          if (poll.question_id !== questionId) {
            return Response.json({ error: 'Poll does not belong to this question' }, { status: 400 });
          }
          pollId = poll.id;
          pollRow = poll;
        }

        // Get option labels. Open-options waves: use the wave's live option
        // set (seeds + write-ins) from poll_options; otherwise a_options.
        const query = await env.DB.prepare(
          'SELECT a_options FROM queries WHERE id = ?'
        ).bind(questionId).first() as { a_options: string } | null;

        if (!query) {
          return Response.json({ error: 'Question not found' }, { status: 404 });
        }

        let options: string[] = [];
        const openCfg = pollRow ? parseOptionsConfig(pollRow.options_config) : null;
        if (openCfg && pollRow) {
          options = (await listVisibleOptions(env.DB, pollRow.id)).map((o) => o.label);
        } else {
          try {
            const parsed = JSON.parse(query.a_options);
            if (Array.isArray(parsed)) options = parsed.filter(o => typeof o === 'string');
          } catch { /* ignore */ }
        }

        // Get counts using shared CTE-based count (only latest per user);
        // scoped to the wave first so cross-wave labels never leak into the
        // stray reconciliation below.
        const { counts, total } = await getMcCounts(env.DB, questionId, pollId);

        // Any voted label outside the declared option set (hidden option,
        // legacy unseeded value) still appears, ordered by count.
        const declared = new Set(options);
        const strays = Object.entries(counts)
          .filter(([label]) => !declared.has(label))
          .sort((a, b) => b[1] - a[1])
          .map(([label]) => label);
        options = [...options, ...strays];

        // The viewer's own latest answer (Public or their own Anon, found by
        // their author tags). A Secret answer shows on the question as "your
        // answer" instead; its stored value here is only the sealed marker.
        let userAnswer: { option_index: number; option_label: string } | null = null;
        const viewerKey = await getOptionalUserKey(request, env);
        if (viewerKey !== undefined) {
          const { getExistingAnswer } = await import('../services/AnswerCountService');
          const tags = (await anonTagReady(env)) ? await authorTags(env, viewerKey, questionId) : null;
          const answer = await getExistingAnswer(env.DB, questionId, viewerKey, 2, pollId, tags);
          if (answer?.value && (answer.audience === 'Public' || answer.audience === 'Anon')) {
            const idx = options.indexOf(answer.value);
            userAnswer = { option_index: idx >= 0 ? idx : 0, option_label: answer.value };
          }
        }

        return Response.json({
          question_id: questionId,
          ...(pollId ? { poll_id: pollId } : {}),
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
    const answerLikeMatch = pathname.match(/^\/api\/answers\/([a-zA-Z0-9_-]+)\/like$/);
    if (answerLikeMatch && request.method === "POST") {
      const allowed = await rateLimitService.checkLimit(ip, 60, 60, 'answers:like'); // 60 req/min
      if (!allowed) return new Response("Too Many Requests", { status: 429 });

      // Verify authentication
      const auth = await requireFlexibleAuth(request, env);
      if (!auth.authenticated || auth.userKey === undefined) {
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

        // New likes are written under the person key (TEXT column: bind a
        // string). Older likes may carry the legacy `quilAddress || String(fid)`
        // forms; unlike and "has liked" match every form this person has.
        const userId = String(auth.userKey);
        const likeIds = likeIdentitiesForAuth(auth);
        const likeIdList = likeIds.map(() => '?').join(',');
        const now = Date.now();

        if (body.action === 'like') {
          // Insert like (or ignore if already liked under any of this person's forms)
          const likeId = crypto.randomUUID();
          await env.DB.prepare(
            `INSERT INTO answer_likes (id, answer_id, user_id, created_at)
             SELECT ?, ?, ?, ?
             WHERE NOT EXISTS (SELECT 1 FROM answer_likes WHERE answer_id = ? AND user_id IN (${likeIdList}))
             ON CONFLICT (answer_id, user_id) DO NOTHING`
          ).bind(likeId, answerId, userId, now, answerId, ...likeIds).run();
        } else {
          // Remove like (D1 only)
          await env.DB.prepare(
            `DELETE FROM answer_likes WHERE answer_id = ? AND user_id IN (${likeIdList})`
          ).bind(answerId, ...likeIds).run();
        }

        // Get updated like count
        const countResult = await env.DB.prepare(
          `SELECT COUNT(*) as count FROM answer_likes WHERE answer_id = ?`
        ).bind(answerId).first();

        const likeCount = (countResult?.count as number) || 0;

        // Check if user has liked
        const userLikeResult = await env.DB.prepare(
          `SELECT 1 FROM answer_likes WHERE answer_id = ? AND user_id IN (${likeIdList})`
        ).bind(answerId, ...likeIds).first();

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
    const answerIdMatch = pathname.match(/^\/api\/answers\/([a-zA-Z0-9_-]+)$/);
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
      if (!auth.authenticated || auth.userKey === undefined) {
        return new Response(auth.error || "Unauthorized", { status: 401 });
      }

      return handleUpdateAnswer(request, env, answerIdMatch[1], auth.userKey);
    }

    // DELETE /api/answers/:id - Delete an answer (requires auth)
    if (answerIdMatch && request.method === "DELETE") {
      const auth = await requireFlexibleAuth(request, env);
      if (!auth.authenticated || auth.userKey === undefined) {
        return new Response(auth.error || "Unauthorized", { status: 401 });
      }

      return handleDeleteAnswer(answerIdMatch[1], env, auth.userKey);
    }
  }

  // GET /api/users/:fid/answers - Get user's existing answer(s) for a specific question.
  // Public answers are visible to anyone; Private/Allowlist payloads and
  // is_own_anon attributions are only returned to the responder themselves
  // (enforced inside handleGetUserAnswers via the requester's person key).
  const userAnswersMatch = pathname.match(/^\/api\/users\/(\d+)\/answers$/);
  if (userAnswersMatch && request.method === "GET") {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const rateLimitService = RateLimitService.fromEnv(env);
    const allowed = await rateLimitService.checkLimit(ip, 60, 60, 'users:answers'); // 60 req/min
    if (!allowed) return new Response("Too Many Requests", { status: 429 });

    // Auth is optional here — we still return Public answers to anonymous
    // callers — but the requester's person key gates the privileged branches.
    const auth = await requireFlexibleAuth(request, env);
    const requesterKey = auth.authenticated ? auth.userKey : undefined;

    return handleGetUserAnswers(request, env, userAnswersMatch[1], requesterKey);
  }

  return null;
}
/**
 * Resolve an AuthResult to a user_id string (quil_address preferred, FID fallback).
 */
