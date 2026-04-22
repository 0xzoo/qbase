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
import { handleListAnswers, handleGetQuery, handleListQueries, handleCreateQuery } from '../api-bridge';
import { requireFlexibleAuth } from '../middleware/auth';
import { ensureUserExists } from '../middleware/userAutoCreate';
import { RateLimitService } from '../services/RateLimitService';
import { TopicService } from '../services/TopicService';

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
    const answersMatch = url.pathname.match(/^\/api\/queries\/([a-zA-Z0-9-]+)\/answers$/);
    if (answersMatch && request.method === "GET") {
      const allowed = await rateLimitService.checkLimit(ip, 60, 60, 'queries:answers'); // 60 req/min for reads
      if (!allowed) return new Response("Too Many Requests", { status: 429 });
      return handleListAnswers(request, env, answersMatch[1]);
    }

    // GET /api/queries/:id - Get a single query
    const idMatch = url.pathname.match(/^\/api\/queries\/([a-zA-Z0-9-]+)$/);
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
    const syncMatch = url.pathname.match(/^\/api\/queries\/([a-zA-Z0-9-]+)\/sync-counts$/);
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

        // Count public + anon answers from D1 (D1 only stores Public and Anon, not Private/Allowlist)
        const d1CountResult = await env.DB.prepare(
          "SELECT COUNT(*) as count FROM Answers WHERE q_id = ?"
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
            `SELECT COUNT(*) as count FROM Answers WHERE q_id = ? AND audience IN ('Private', 'Allowlist')`
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
    const queryTopicsMatch = url.pathname.match(/^\/api\/queries\/([a-zA-Z0-9-]+)\/topics$/);
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
