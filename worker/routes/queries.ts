/**
 * Queries API Routes
 * 
 * Handles:
 * - GET /api/queries/:id/answers - List answers for query
 * - GET /api/queries/:id - Get single query
 * - GET /api/queries - List all queries
 * - POST /api/queries/:id/sync-counts - Sync answer counts
 * - POST /api/queries - Create new query
 * - GET /api/queries/:id/topics - Get topics for query
 */

// @ts-nocheck
import { handleListAnswers, handleListUserAnswersForQuery } from '../handlers/answers';
import { handleGetQuery, handleListQueries, handleCreateQuery, handleListForks } from '../handlers/queries';
import { requireFlexibleAuth } from '../middleware/auth';
import { ensureUserExists } from '../middleware/userAutoCreate';
import { RateLimitService } from '../services/RateLimitService';
import { TopicService } from '../services/TopicService';
import { EligibilityService } from '../services/EligibilityService';
import { BetaWhitelistService } from '../services/BetaWhitelistService';
import { addOrVoteWriteIn, listVisibleOptions, listAllOptions, setOptionHidden } from '../services/PollOptionsService';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

// Query submission type (simplified since we have @ts-nocheck)
interface QuerySubmission {
  coiner_id?: number;
  coiner_fid?: number;
  coiner_fname?: string;
  [key: string]: any;
}

interface Context {
  waitUntil: (promise: Promise<any>) => void;
}

/**
 * Handle queries-related API routes
 */
export async function handleQueriesRoutes(request: Request, env: Env, ctx?: Context): Promise<Response | null> {
  const url = new URL(request.url);

  // Queries endpoints
  if (url.pathname.startsWith("/api/queries")) {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const rateLimitService = RateLimitService.fromEnv(env);

    // GET /api/queries/:id/answers - List answers for a query (public endpoint)
    const answersMatch = url.pathname.match(/^\/api\/queries\/([a-zA-Z0-9_-]+)\/answers$/);
    if (answersMatch && request.method === "GET") {
      const allowed = await rateLimitService.checkLimit(ip, 60, 60, 'queries:answers'); // 60 req/min for reads
      if (!allowed) return new Response("Too Many Requests", { status: 429 });
      return handleListAnswers(request, env, answersMatch[1]);
    }

    // GET /api/queries/:id/users/:fid/answers - List a user's public answers for a query
    const userAnswersForQueryMatch = url.pathname.match(/^\/api\/queries\/([a-zA-Z0-9_-]+)\/users\/(\d+)\/answers$/);
    if (userAnswersForQueryMatch && request.method === "GET") {
      const allowed = await rateLimitService.checkLimit(ip, 60, 60, 'queries:user-answers');
      if (!allowed) return new Response("Too Many Requests", { status: 429 });
      return handleListUserAnswersForQuery(request, env, userAnswersForQueryMatch[1], userAnswersForQueryMatch[2]);
    }

    // GET /api/queries/:id/forks - List questions forked from :id
    const forksMatch = url.pathname.match(/^\/api\/queries\/([a-zA-Z0-9_-]+)\/forks$/);
    if (forksMatch && request.method === "GET") {
      const allowed = await rateLimitService.checkLimit(ip, 60, 60, 'queries:forks');
      if (!allowed) return new Response("Too Many Requests", { status: 429 });
      return handleListForks(request, env, forksMatch[1]);
    }

    // GET /api/queries/:id/aggregate — public distribution for the aggregate
    // result page (/question/:id/results) and its OG chart. Counts mirror the
    // snap result scenes (latest answer per user, Public/Anon only).
    const aggregateMatch = url.pathname.match(/^\/api\/queries\/([a-zA-Z0-9_-]+)\/aggregate$/);
    if (aggregateMatch && request.method === "GET") {
      const allowed = await rateLimitService.checkLimit(ip, 120, 60, 'queries:aggregate');
      if (!allowed) return new Response("Too Many Requests", { status: 429 });
      try {
        const { getAggregateResults } = await import('../services/AggregateResultsService');
        const data = await getAggregateResults(env.DB, aggregateMatch[1]);
        if (!data) return Response.json({ error: 'Question not found' }, { status: 404 });
        return Response.json(data, {
          headers: { 'Cache-Control': 'public, max-age=60' },
        });
      } catch (error) {
        console.error('[Aggregate Results] Error:', error);
        return Response.json({ error: 'Failed to fetch aggregate results' }, { status: 500 });
      }
    }

    // GET /api/queries/:id/eligibility?fid=N — eligibility probe for a poll.
    // Returns { eligible, reason, closesAt? } for the given FID. Result is
    // KV-cached server-side (snapshots are immutable). Public; rate-limited.
    const eligibilityMatch = url.pathname.match(/^\/api\/queries\/([a-zA-Z0-9_-]+)\/eligibility$/);
    if (eligibilityMatch && request.method === "GET") {
      const allowed = await rateLimitService.checkLimit(ip, 120, 60, 'queries:eligibility');
      if (!allowed) return new Response("Too Many Requests", { status: 429 });
      const fidParam = url.searchParams.get('fid');
      if (!fidParam) return Response.json({ error: 'fid query param required' }, { status: 400 });
      const fid = parseInt(fidParam, 10);
      if (!Number.isFinite(fid)) return Response.json({ error: 'fid must be numeric' }, { status: 400 });
      const result = await EligibilityService.checkById(env, eligibilityMatch[1], fid);
      if (!result) return Response.json({ error: 'query not found' }, { status: 404 });
      return Response.json(result);
    }

    // ── Open-options polls (write-in MC) ─────────────────────────────────────

    // GET /api/queries/:id/options — visible options for an open poll, in
    // declared order. Public; created_by_fid is never returned.
    const optionsMatch = url.pathname.match(/^\/api\/queries\/([a-zA-Z0-9_-]+)\/options$/);
    if (optionsMatch && request.method === "GET") {
      const allowed = await rateLimitService.checkLimit(ip, 120, 60, 'queries:options-list');
      if (!allowed) return new Response("Too Many Requests", { status: 429 });
      const options = await listVisibleOptions(env.DB, optionsMatch[1]);
      return Response.json({ options }, { headers: { 'Cache-Control': 'public, max-age=10' } });
    }

    // POST /api/queries/:id/options — add a write-in option (or merge into an
    // existing one) AND record the submitter's vote. Auth required.
    if (optionsMatch && request.method === "POST") {
      const allowed = await rateLimitService.checkLimit(ip, 5, 60, 'queries:writein');
      if (!allowed) {
        return new Response(JSON.stringify({ error: "Too many write-ins. Please wait a moment." }),
          { status: 429, headers: { 'Content-Type': 'application/json' } });
      }
      const auth = await requireFlexibleAuth(request, env);
      if (!auth.authenticated || !auth.fid) {
        return new Response(auth.error || "Unauthorized", { status: 401 });
      }
      let body;
      try { body = await request.json(); } catch { return Response.json({ error: 'Invalid JSON' }, { status: 400 }); }
      const label = typeof body?.label === 'string' ? body.label : '';
      // ── Poll eligibility gate ──
      // The write-in path records a vote, so it must enforce closes_at +
      // eligibility_gate exactly like answers/create.ts does. (Fixed
      // 2026-09-05: this endpoint previously accepted votes on closed or
      // holder-gated polls — the snap write-in path was locked, this one was not.)
      const elig = await EligibilityService.checkById(env, optionsMatch[1], auth.fid);
      if (!elig) return Response.json({ error: 'query not found' }, { status: 404 });
      if (!elig.eligible) {
        if (elig.reason === 'closed') {
          return Response.json(
            { error: 'Voting has closed for this poll', code: 'poll_closed', closes_at: elig.closesAt },
            { status: 423 },
          );
        }
        return Response.json(
          { error: 'You are not eligible to answer this poll', code: 'not_eligible' },
          { status: 403 },
        );
      }
      // Ensure the voting user exists (FK on Answers.user_id).
      const userRow = await ensureUserExists(env, auth.fid);
      if (!userRow) return new Response('Failed to create/retrieve user', { status: 500 });
      const result = await addOrVoteWriteIn(env, optionsMatch[1], auth.fid, label, 'Public');
      if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
      return Response.json({ option: result.option, merged: result.merged });
    }

    // PATCH /api/queries/:id/options/:oid — hide/unhide an option (moderation).
    // Gated to the question's creator or an admin. Body: { hidden?: boolean }.
    const optionModMatch = url.pathname.match(/^\/api\/queries\/([a-zA-Z0-9_-]+)\/options\/([a-zA-Z0-9_-]+)$/);
    if (optionModMatch && request.method === "PATCH") {
      const auth = await requireFlexibleAuth(request, env);
      if (!auth.authenticated || !auth.fid) {
        return new Response(auth.error || "Unauthorized", { status: 401 });
      }
      const q = await env.DB.prepare('SELECT coiner_fid FROM queries WHERE id = ?')
        .bind(optionModMatch[1]).first();
      if (!q) return Response.json({ error: 'query not found' }, { status: 404 });
      const isCreator = Number(q.coiner_fid) === Number(auth.fid);
      if (!isCreator && !BetaWhitelistService.isAdmin(auth.fid)) {
        return new Response("Forbidden", { status: 403 });
      }
      let body;
      try { body = await request.json(); } catch { body = {}; }
      const hidden = body?.hidden !== false; // default → hide
      const ok = await setOptionHidden(env.DB, optionModMatch[1], optionModMatch[2], hidden);
      if (!ok) return Response.json({ error: 'option not found' }, { status: 404 });
      return Response.json({ ok: true, hidden });
    }

    // GET /api/queries/:id/options/all — all options incl. hidden (creator/admin).
    const optionsAllMatch = url.pathname.match(/^\/api\/queries\/([a-zA-Z0-9_-]+)\/options\/all$/);
    if (optionsAllMatch && request.method === "GET") {
      const auth = await requireFlexibleAuth(request, env);
      if (!auth.authenticated || !auth.fid) {
        return new Response(auth.error || "Unauthorized", { status: 401 });
      }
      const q = await env.DB.prepare('SELECT coiner_fid FROM queries WHERE id = ?')
        .bind(optionsAllMatch[1]).first();
      if (!q) return Response.json({ error: 'query not found' }, { status: 404 });
      const isCreator = Number(q.coiner_fid) === Number(auth.fid);
      if (!isCreator && !BetaWhitelistService.isAdmin(auth.fid)) {
        return new Response("Forbidden", { status: 403 });
      }
      const options = await listAllOptions(env.DB, optionsAllMatch[1]);
      return Response.json({ options });
    }

    // POST /api/queries/:id/like - Like or unlike a question (requires auth + Farcaster signer).
    // Question likes are Farcaster reactions on the question's cast — we proxy to Neynar
    // using the user's approved signer, then mirror into farcaster_reactions for fast reads.
    const queryLikeMatch = url.pathname.match(/^\/api\/queries\/([a-zA-Z0-9_-]+)\/like$/);
    if (queryLikeMatch && request.method === "POST") {
      const allowed = await rateLimitService.checkLimit(ip, 60, 60, 'queries:like');
      if (!allowed) return new Response("Too Many Requests", { status: 429 });

      const auth = await requireFlexibleAuth(request, env);
      if (!auth.authenticated || !auth.fid) {
        return new Response(auth.error || "Unauthorized", { status: 401 });
      }

      const questionId = queryLikeMatch[1];
      try {
        const body = await request.json() as { action: 'like' | 'unlike' };
        if (!body.action || !['like', 'unlike'].includes(body.action)) {
          return Response.json({ error: 'action must be "like" or "unlike"' }, { status: 400 });
        }

        // Resolve the question's Farcaster cast hash. Likes only work once a cast exists.
        const castRow = await env.DB.prepare(
          `SELECT cast_hash FROM farcaster_casts WHERE entity_type = 'query' AND entity_id = ? LIMIT 1`
        ).bind(questionId).first() as { cast_hash: string } | null;

        if (!castRow?.cast_hash) {
          return Response.json(
            { error: 'This question has not been cast to Farcaster yet. Try again in a moment.' },
            { status: 409 }
          );
        }

        // Resolve the user's approved Neynar signer.
        const signerRow = await env.DB.prepare(
          `SELECT signer_uuid FROM user_signers
           WHERE fid = ? AND status = 'approved' AND provider = 'neynar'
           ORDER BY updated_at DESC LIMIT 1`
        ).bind(auth.fid).first() as { signer_uuid: string } | null;

        if (!signerRow) {
          return Response.json(
            { error: 'Connect your Farcaster account to like questions.', needsSigner: true },
            { status: 403 }
          );
        }

        // Call Neynar to add/remove the reaction on Farcaster.
        const apiKey = env.NEYNAR_API_KEY;
        if (!apiKey) {
          return Response.json({ error: 'Reactions are not configured' }, { status: 503 });
        }

        const { NeynarSignerService } = await import('../services/NeynarSignerService');
        const neynar = new NeynarSignerService(apiKey);

        if (body.action === 'like') {
          await neynar.publishReaction({
            signerUuid: signerRow.signer_uuid,
            reactionType: 'like',
            targetCastHash: castRow.cast_hash,
          });
        } else {
          await neynar.removeReaction({
            signerUuid: signerRow.signer_uuid,
            reactionType: 'like',
            targetCastHash: castRow.cast_hash,
          });
        }

        // Mirror into farcaster_reactions so the GET handler reflects it without
        // waiting for the periodic Farcaster sync.
        const { FarcasterDBService } = await import('../services/FarcasterDBService');
        if (body.action === 'like') {
          await FarcasterDBService.upsertReaction(env.DB, {
            cast_hash: castRow.cast_hash,
            reactor_fid: auth.fid,
            reaction_type: 'like',
            source: 'qbase',
          });
        } else {
          await FarcasterDBService.deleteReaction(env.DB, castRow.cast_hash, auth.fid, 'like');
        }

        // Return the updated cached count so the client can reconcile its optimistic state.
        const countRow = await env.DB.prepare(
          `SELECT COUNT(*) as count FROM farcaster_reactions
           WHERE cast_hash = ? AND reaction_type = 'like' AND is_deleted = 0`
        ).bind(castRow.cast_hash).first() as { count: number } | null;

        return Response.json({
          success: true,
          like_count: countRow?.count ?? 0,
          user_has_liked: body.action === 'like',
        });
      } catch (e: any) {
        console.error('[Query Like] Error:', e);
        return Response.json(
          { error: e?.message || 'Failed to process like action' },
          { status: 500 }
        );
      }
    }

    // GET /api/queries/:id - Get a single query
    const idMatch = url.pathname.match(/^\/api\/queries\/([a-zA-Z0-9_-]+)$/);
    if (idMatch && request.method === "GET") {
      const allowed = await rateLimitService.checkLimit(ip, 60, 60, 'queries:get'); // 60 req/min for reads
      if (!allowed) return new Response("Too Many Requests", { status: 429 });
      return handleGetQuery(request, env, idMatch[1]);
    }

    // GET /api/queries - List all queries
    if (url.pathname === "/api/queries" && request.method === "GET") {
      const allowed = await rateLimitService.checkLimit(ip, 60, 60, 'queries:list'); // 60 req/min for reads
      if (!allowed) return new Response("Too Many Requests", { status: 429 });
      return handleListQueries(request, env);
    }

    // POST /api/queries/:id/sync-counts - Sync pub_answers and priv_answers from actual counts
    // Includes: Public answers, Anon answers, and Farcaster replies
    const syncMatch = url.pathname.match(/^\/api\/queries\/([a-zA-Z0-9_-]+)\/sync-counts$/);
    if (syncMatch && request.method === "POST") {
      const allowed = await rateLimitService.checkLimit(ip, 10, 60, 'queries:sync'); // 10 req/min for writes
      if (!allowed) return new Response("Too Many Requests", { status: 429 });

      const queryId = syncMatch[1];

      try {
        // Get query with cast_hash
        const query = await env.DB.prepare(`
          SELECT q.id, fc.cast_hash 
          FROM queries q
          LEFT JOIN farcaster_casts fc ON fc.entity_type = 'query' AND fc.entity_id = q.id
          WHERE q.id = ?
        `).bind(queryId).first() as { id: string; cast_hash?: string } | null;

        if (!query) {
          return new Response('Query not found', { status: 404 });
        }

        // Count unique public + anon responders from D1
        // COUNT(DISTINCT user_id) handles append-only (multiple rows per user)
        const d1CountResult = await env.DB.prepare(
          "SELECT COUNT(DISTINCT user_id) as count FROM Answers WHERE q_id = ? AND audience IN ('Public', 'Anon')"
        ).bind(queryId).first() as { count: number } | null;
        const d1AnswerCount = d1CountResult?.count || 0;

        // Count Farcaster replies if cast_hash exists
        let farcasterRepliesCount = 0;
        if (query.cast_hash) {
          try {
            const { createHypersnapService } = await import('../services/HypersnapService');
            const hypersnap = createHypersnapService(env);
            const [cast, replies] = await Promise.all([
              hypersnap.getCastByHash(query.cast_hash),
              hypersnap.getCastRepliesByParent(query.cast_hash, 25),
            ]);

            // If cast is null, it was deleted — clear the cast_hash from farcaster_casts
            if (cast === null) {
              console.log(`[Farcaster Stats] Cast ${query.cast_hash} deleted, clearing from DB`);
              await env.DB.prepare(
                "DELETE FROM farcaster_casts WHERE cast_hash = ?"
              ).bind(query.cast_hash).run();
              // Also clear from queries table if stored there
              await env.DB.prepare(
                "UPDATE Queries SET cast_hash = NULL WHERE cast_hash = ?"
              ).bind(query.cast_hash).run();
            } else {
              // Use the reply count from Hypersnap
              farcasterRepliesCount = replies.length;
            }
          } catch (neynarError) {
            console.error('Error fetching Farcaster replies count:', neynarError);
            // Continue without Farcaster replies if API fails
          }
        }

        // Total public-facing answers (D1 answers + Farcaster replies)
        const totalPubAnswers = d1AnswerCount + farcasterRepliesCount;

        // Count private/allowlist answers from D1
        let privCount = 0;
        try {
          const privResult = await env.DB.prepare(
            `SELECT COUNT(DISTINCT user_id) as count FROM Answers WHERE q_id = ? AND audience IN ('Private', 'Allowlist')`
          ).bind(queryId).first<{ count: number }>();
          privCount = privResult?.count || 0;
        } catch (countError) {
          console.error('Error counting private answers:', countError);
        }

        // Update the queries table
        await env.DB.prepare(
          'UPDATE queries SET pub_answers = ?, priv_answers = ? WHERE id = ?'
        ).bind(totalPubAnswers, privCount, queryId).run();

        return Response.json({
          success: true,
          queryId,
          pub_answers: totalPubAnswers,
          priv_answers: privCount,
          details: {
            d1_answers: d1AnswerCount,
            farcaster_replies: farcasterRepliesCount,
            private: privCount
          }
        });
      } catch (error) {
        console.error('Error syncing answer counts:', error);
        return new Response('Failed to sync answer counts', { status: 500 });
      }
    }

    // POST /api/queries - Create a new query (requires auth)
    if (url.pathname === "/api/queries" && request.method === "POST") {
      const allowed = await rateLimitService.checkLimit(ip, 20, 60, 'queries:create'); // 20 req/min for writes
      if (!allowed) return new Response(JSON.stringify({ error: "Too many requests. Please wait a moment and try again." }), { status: 429, headers: { 'Content-Type': 'application/json' } });

      // Verify authentication
      const auth = await requireFlexibleAuth(request, env);
      if (!auth.authenticated) {
        return new Response(auth.error || "Unauthorized", { status: 401 });
      }

      try {
        const body = await request.json() as Omit<QuerySubmission, 'coiner_id' | 'coiner_fid' | 'coiner_fname'>;

        // Ensure user exists in DB (auto-create if needed)
        const userRow = await ensureUserExists(env, auth.fid);

        if (!userRow) {
          return new Response('Failed to create/retrieve user', { status: 500 });
        }

        // Inject authenticated user data into the request body
        // This prevents client manipulation of user identity
        const verifiedBody = {
          ...body,
          coiner_id: userRow.id,      // Internal DB ID
          coiner_fid: auth.fid,       // FID from JWT
          coiner_fname: userRow.fname // Username from DB
        };

        // Add verified FID to headers for the handler
        const headers = new Headers(request.headers);
        headers.set('X-Verified-FID', auth.fid.toString());

        const verifiedRequest = new Request(request.url, {
          method: request.method,
          headers: headers,
          body: JSON.stringify(verifiedBody)
        });

        return handleCreateQuery(verifiedRequest, env, ctx);
      } catch (e) {
        console.error('Error validating query request:', e);
        return new Response('Invalid request', { status: 400 });
      }
    }

    // GET /api/queries/:id/topics - Get topics for a query
    const queryTopicsMatch = url.pathname.match(/^\/api\/queries\/([a-zA-Z0-9_-]+)\/topics$/);
    if (queryTopicsMatch && request.method === "GET") {
      const allowed = await rateLimitService.checkLimit(ip, 60, 60, 'queries:topics');
      if (!allowed) return new Response("Too Many Requests", { status: 429 });

      try {
        const queryId = queryTopicsMatch[1];
        const topics = await TopicService.getQueryTopics(env.DB, queryId);
        return Response.json({ topics });
      } catch (error) {
        console.error("Error fetching query topics:", error);
        return new Response.json({ error: 'Failed to fetch query topics' }, { status: 500 });
      }
    }
  }

  return null;
}
