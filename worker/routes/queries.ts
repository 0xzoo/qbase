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
import { handleListAnswers, handleListUserAnswersForQuery, handleListMyAnswersForQuery } from '../handlers/answers';
import { handleGetQuery, handleListQueries, handleCreateQuery, handleListForks } from '../handlers/queries';
import { requireFlexibleAuth } from '../middleware/auth';
import { ensureUserExists } from '../middleware/userAutoCreate';
import { RateLimitService } from '../services/RateLimitService';
import { TopicService } from '../services/TopicService';
import { EligibilityService } from '../services/EligibilityService';
import { listPollsForQuestion, toPublicPoll } from '../services/PollService';
import { BetaWhitelistService } from '../services/BetaWhitelistService';
import { personKeySql } from '../services/anon/AnonTag';
import { isAccountId } from '../services/accounts/AccountService';

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

    // GET /api/queries/:id/answers/mine - The signed-in person's history on this question (owner-only)
    const mineMatch = url.pathname.match(/^\/api\/queries\/([a-zA-Z0-9_-]+)\/answers\/mine$/);
    if (mineMatch && request.method === "GET") {
      const allowed = await rateLimitService.checkLimit(ip, 60, 60, 'queries:my-answers');
      if (!allowed) return new Response("Too Many Requests", { status: 429 });
      return handleListMyAnswersForQuery(request, env, mineMatch[1]);
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

    // GET /api/queries/:id/polls — every wave on a question, newest first.
    const pollsMatch = url.pathname.match(/^\/api\/queries\/([a-zA-Z0-9_-]+)\/polls$/);
    if (pollsMatch && request.method === "GET") {
      const allowed = await rateLimitService.checkLimit(ip, 120, 60, 'queries:polls');
      if (!allowed) return new Response("Too Many Requests", { status: 429 });
      const exists = await env.DB.prepare('SELECT id FROM queries WHERE id = ? LIMIT 1').bind(pollsMatch[1]).first();
      if (!exists) return Response.json({ error: 'query not found' }, { status: 404 });
      const polls = await listPollsForQuestion(env.DB, pollsMatch[1]);
      return Response.json({ polls: polls.map(p => toPublicPoll(p)) }, { headers: { 'Cache-Control': 'public, max-age=10' } });
    }

    // GET /api/queries/:id/eligibility?fid=N — eligibility probe against the
    // question's current wave. Returns { eligible, reason, closesAt?, pollId? }
    // for the given FID; a question with no wave is always `no_gate`. Result
    // is KV-cached server-side per wave (snapshots are immutable). Public;
    // rate-limited.
    const eligibilityMatch = url.pathname.match(/^\/api\/queries\/([a-zA-Z0-9_-]+)\/eligibility$/);
    if (eligibilityMatch && request.method === "GET") {
      const allowed = await rateLimitService.checkLimit(ip, 120, 60, 'queries:eligibility');
      if (!allowed) return new Response("Too Many Requests", { status: 429 });
      const fidParam = url.searchParams.get('fid');
      if (!fidParam) return Response.json({ error: 'fid query param required' }, { status: 400 });
      const fid = parseInt(fidParam, 10);
      if (!Number.isFinite(fid)) return Response.json({ error: 'fid must be numeric' }, { status: 400 });
      const result = await EligibilityService.checkQuestion(env, eligibilityMatch[1], fid);
      if (!result) return Response.json({ error: 'query not found' }, { status: 404 });
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { poll: _poll, ...publicResult } = result;
      return Response.json(publicResult);
    }

    // Open-options endpoints live on the wave: /api/polls/:id/options* (Track A5).

    // POST /api/queries/:id/like - Like or unlike a question (requires auth + Farcaster signer).
    // Question likes are Farcaster reactions on the question's cast — published through
    // the ReactionRouter (hub signer first, grandfathered Neynar signer as fallback), then
    // mirrored into farcaster_reactions for fast reads.
    const queryLikeMatch = url.pathname.match(/^\/api\/queries\/([a-zA-Z0-9_-]+)\/like$/);
    if (queryLikeMatch && request.method === "POST") {
      const allowed = await rateLimitService.checkLimit(ip, 60, 60, 'queries:like');
      if (!allowed) return new Response("Too Many Requests", { status: 429 });

      const auth = await requireFlexibleAuth(request, env);
      if (!auth.authenticated) {
        return new Response(auth.error || "Unauthorized", { status: 401 });
      }
      // A question like is a Farcaster reaction by the linked fid.
      if (!auth.fid) {
        return Response.json({ error: 'farcaster_required' }, { status: 409 });
      }

      const questionId = queryLikeMatch[1];
      try {
        const body = await request.json() as { action: 'like' | 'unlike' };
        if (!body.action || !['like', 'unlike'].includes(body.action)) {
          return Response.json({ error: 'action must be "like" or "unlike"' }, { status: 400 });
        }

        // Resolve the question's Farcaster cast (hash + author). Likes only work once a cast exists.
        const castRow = await env.DB.prepare(
          `SELECT cast_hash, caster_fid FROM farcaster_casts WHERE entity_type = 'query' AND entity_id = ? LIMIT 1`
        ).bind(questionId).first() as { cast_hash: string; caster_fid: number } | null;

        if (!castRow?.cast_hash) {
          return Response.json(
            { error: 'This question has not been cast to Farcaster yet. Try again in a moment.' },
            { status: 409 }
          );
        }

        const { initReactionRouter } = await import('../services/casting');
        let reactions;
        try {
          reactions = initReactionRouter(env);
        } catch {
          return Response.json({ error: 'Reactions are not configured' }, { status: 503 });
        }

        if (!(await reactions.canReact(auth.fid, env))) {
          return Response.json(
            { error: 'Connect your Farcaster account to like questions.', needsSigner: true },
            { status: 403 }
          );
        }

        const payload = {
          fid: auth.fid,
          type: 'like' as const,
          targetHash: castRow.cast_hash,
          targetAuthorFid: Number(castRow.caster_fid),
        };
        if (body.action === 'like') {
          await reactions.add(payload, env);
        } else {
          await reactions.remove(payload, env);
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

    // POST /api/queries/:id/cast-hash — attach a client-produced cast to a query
    // (signerless composeCast path; see docs/plans/signerless-question-creation.md
    // Phase 2). The client cast the question itself via sdk.actions.composeCast and
    // anchors the resulting hash here. Auth required; the caller must be the
    // question's coiner (for anon questions, resolved via anon_attributions).
    const castHashMatch = url.pathname.match(/^\/api\/queries\/([a-zA-Z0-9_-]+)\/cast-hash$/);
    if (castHashMatch && request.method === "POST") {
      const allowed = await rateLimitService.checkLimit(ip, 10, 60, 'queries:cast-hash'); // 10 req/min like other writes
      if (!allowed) return new Response("Too Many Requests", { status: 429 });

      const auth = await requireFlexibleAuth(request, env);
      if (!auth.authenticated || auth.userKey === undefined) {
        return new Response(auth.error || "Unauthorized", { status: 401 });
      }
      // Anchoring a cast is a Farcaster operation: the cast's author must be the linked fid.
      if (!auth.fid) {
        return Response.json({ error: 'farcaster_required' }, { status: 409 });
      }

      const questionId = castHashMatch[1];
      let body: { cast_hash?: string };
      try { body = await request.json(); } catch { return Response.json({ error: 'Invalid JSON' }, { status: 400 }); }

      const castHash = typeof body?.cast_hash === 'string' ? body.cast_hash.trim() : '';
      if (!castHash || !/^0x[0-9a-fA-F]{8,64}$/.test(castHash)) {
        return Response.json({ error: 'cast_hash must be a 0x-prefixed hex hash' }, { status: 400 });
      }

      try {
        // 1. Ownership check: coiner_fid === auth.fid (a Farcaster fact), or —
        //    for a question created by an account before it linked Farcaster —
        //    coiner_id === the account id (only for a real account id: before the
        //    cutover coiner_id mixes legacy internal ids and fids). For anon
        //    questions the coiner_* columns are masked to 4n0n/514282 — resolve
        //    the real author via anon_attributions, tagged over the person key.
        const q = await env.DB.prepare(
          'SELECT id, coiner_fid, coiner_id FROM queries WHERE id = ?'
        ).bind(questionId).first() as { id: string; coiner_fid: number | null; coiner_id: number | null } | null;
        if (!q) return Response.json({ error: 'Query not found' }, { status: 404 });

        const anonFid = Number(env.ANON_FID) || 514282;
        let isOwner = q.coiner_fid != null && Number(q.coiner_fid) === Number(auth.fid);
        if (!isOwner && isAccountId(auth.userKey) && Number(q.coiner_id) === auth.userKey) isOwner = true;
        if (!isOwner && Number(q.coiner_fid) === anonFid) {
          const { isAuthor } = await import('../services/AnonAttributionService');
          isOwner = await isAuthor(env, questionId, Number(auth.userKey), questionId, 'question');
        }
        if (!isOwner && !BetaWhitelistService.isAdmin(auth.fid)) {
          return new Response("Forbidden", { status: 403 });
        }

        // 2. Idempotency / conflict guard before hitting the network.
        const meta = await env.DB.prepare(
          'SELECT cast_hash, cast_status FROM question_meta WHERE question_id = ?'
        ).bind(questionId).first() as { cast_hash: string | null; cast_status: string | null } | null;

        const storedHash = meta?.cast_hash ?? null;
        if (storedHash && storedHash.toLowerCase() === castHash.toLowerCase()) {
          return Response.json({ success: true, cast_hash: castHash, idempotent: true });
        }
        if (storedHash && meta?.cast_status === 'active') {
          return Response.json(
            { error: 'Question already has an active cast anchor', existing_cast_hash: storedHash, code: 'cast_conflict' },
            { status: 409 }
          );
        }

        // 3. Verify the cast's author via Hypersnap. Hub propagation lags a fresh
        //    cast, so retry a few times (mirrors /api/farcaster/signer/connect).
        //    On persistent lookup failure, accept and record — a user can only
        //    attach to their own question, so the worst case is a wrong hash on
        //    their own row.
        let castVerified: boolean | null = null; // null = lookup failed
        try {
          const { createHypersnapService } = await import('../services/HypersnapService');
          const hypersnap = createHypersnapService(env);
          const MAX_ATTEMPTS = 4;
          for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            const cast = await hypersnap.getCastByHash(castHash);
            if (cast) {
              castVerified = Number(cast.author?.fid) === Number(auth.fid);
              break;
            }
            if (attempt < MAX_ATTEMPTS - 1) {
              await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
            }
          }
        } catch (lookupErr) {
          console.error(`[CastHash] Hypersnap lookup failed for ${castHash}:`, lookupErr);
          castVerified = null;
        }

        if (castVerified === false) {
          return Response.json(
            { error: 'Cast author does not match authenticated user', code: 'author_mismatch' },
            { status: 403 }
          );
        }

        // 4. Record: farcaster_casts upsert + question_meta anchor.
        const { FarcasterDBService } = await import('../services/FarcasterDBService');
        await FarcasterDBService.upsertCast(env.DB, {
          entity_type: 'query',
          entity_id: questionId,
          cast_hash: castHash,
          cast_url: `https://farcaster.xyz/${auth.fid}/${castHash}`,
          caster_fid: auth.fid,
        });

        const now = Date.now();
        await env.DB.prepare(
          `UPDATE question_meta SET cast_hash = ?, cast_status = 'active', updated_at = ? WHERE question_id = ?`
        ).bind(castHash, now, questionId).run();

        // 5. Auto-set has_snap for snap-eligible question types — parity with
        //    /api/farcaster/cast (worker/routes/farcaster.ts:129-139).
        const { isSnapEligible } = await import('../services/farcasterShared');
        if (await isSnapEligible(env.DB, questionId)) {
          await env.DB.prepare(
            'UPDATE question_meta SET has_snap = 1 WHERE question_id = ?'
          ).bind(questionId).run();
        }

        return Response.json({
          success: true,
          cast_hash: castHash,
          verified: castVerified === true,
        });
      } catch (e: any) {
        console.error('[CastHash] Error:', e);
        return Response.json({ error: e?.message || 'Failed to attach cast hash' }, { status: 500 });
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
          `SELECT COUNT(DISTINCT ${personKeySql('a')}) as count FROM Answers a WHERE a.q_id = ? AND a.audience IN ('Public', 'Anon')`
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
      if (!auth.authenticated || auth.userKey === undefined) {
        return new Response(auth.error || "Unauthorized", { status: 401 });
      }

      try {
        const body = await request.json() as Omit<QuerySubmission, 'coiner_id' | 'coiner_fid' | 'coiner_fname'>;

        // The profile row. With a linked fid: ensure/refresh it from Farcaster
        // (its id is the person key). Without one: the account's own row,
        // which createAccount wrote.
        let userRow: { id: number; fname: string | null } | null;
        if (auth.fid) {
          userRow = await ensureUserExists(env, auth.fid);
        } else {
          const row = await env.DB.prepare('SELECT fid, fname FROM Users WHERE fid = ?')
            .bind(auth.userKey).first() as { fid: number; fname: string | null } | null;
          userRow = row ? { id: Number(row.fid), fname: row.fname } : null;
        }

        if (!userRow) {
          return new Response('Failed to create/retrieve user', { status: 500 });
        }

        // Inject authenticated user data into the request body
        // This prevents client manipulation of user identity
        const verifiedBody = {
          ...body,
          coiner_id: auth.userKey,        // person key (fid before the cutover, account id after)
          coiner_fid: auth.fid ?? null,   // the linked Farcaster fid; NULL for an account without one
          coiner_fname: userRow.fname     // Username from DB
        };

        // Verified identity for the handler: the person key (QP, attribution)
        // and, when linked, the Farcaster fid (signer check, cast).
        const headers = new Headers(request.headers);
        headers.delete('X-Verified-FID');
        headers.delete('X-Verified-User-Key');
        headers.set('X-Verified-User-Key', String(auth.userKey));
        if (auth.fid) headers.set('X-Verified-FID', auth.fid.toString());

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
