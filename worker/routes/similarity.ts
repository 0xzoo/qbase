/**
 * Similarity and Query Parsing API Routes
 * 
 * Handles:
 * - POST /api/check-similarity - Check text similarity (vector + exact match)
 * - POST /api/review-question - Wording review of a draft question (services/hygiene/questionReview.ts)
 * - POST /api/parse-query - Parse query text using AI
 */

import { VectorService } from '../services/VectorService';
import { AIService } from '../services/AIService';
import { RateLimitService } from '../services/RateLimitService';
import { requireFlexibleAuth } from '../middleware/auth';
import { reviewQuestion } from '../services/hygiene/questionReview';
import { MAX_Q_LENGTH, SIMILARITY_THRESHOLD } from '../../src/lib/consts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

/**
 * Handle similarity and query parsing API routes
 */
export async function handleSimilarityRoutes(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);

  // POST /api/review-question {stem, type, a_options?} → {issues, suggestion?, reviewed}. Advisory: never blocks posting.
  if (url.pathname === '/api/review-question' && request.method === 'POST') {
    const auth = await requireFlexibleAuth(request, env);
    if (!auth.authenticated) return new Response(auth.error || 'Unauthorized', { status: 401 });
    // Over a limit is the same as the model being down: the draft posts unreviewed.
    const limits = RateLimitService.fromEnv(env);
    if (
      !(await limits.checkLimit(`review:${auth.userKey}`, 20, 60, 'review-question')) ||
      !(await limits.checkLimit(`review:${auth.userKey}`, 200, 86400, 'review-question-day')) ||
      !(await limits.checkLimit('review:global', Number(env.HYGIENE_DAILY_CAP) || 20000, 86400, 'review-question-global'))
    ) {
      return Response.json({ issues: [], reviewed: 'unavailable' });
    }
    const body = await request.json().catch(() => null) as { stem?: unknown; type?: unknown; a_options?: unknown } | null;
    const stem = typeof body?.stem === 'string' ? body.stem.trim() : '';
    if (stem.length < 5 || stem.length > MAX_Q_LENGTH) return Response.json({ error: `stem: 5–${MAX_Q_LENGTH} characters` }, { status: 400 });
    const type = body?.type ?? 'text';
    if (typeof type !== 'string' || !['text', 'mc', 'checkbox', 'scale', 'date'].includes(type)) return Response.json({ error: 'bad type' }, { status: 400 });
    const options = Array.isArray(body?.a_options)
      ? (body!.a_options as unknown[]).filter((o): o is string => typeof o === 'string').slice(0, 20).map((o) => o.slice(0, 120))
      : null;
    const review = await reviewQuestion(env.OPENROUTER_API_KEY, { stem, type, options }, { model: env.HYGIENE_MODEL });
    // The rewrite may be a question someone already asked: offer that one before a near-copy. Best effort.
    if (review.suggestion) {
      try {
        const sim = await VectorService.fromEnv(env).checkSimilarity(review.suggestion.stem);
        const top = sim.results[0];
        if (top && top.score >= SIMILARITY_THRESHOLD) {
          const q = await env.DB.prepare('SELECT id, stem FROM queries WHERE id = ? AND COALESCE(template, 0) = 0').bind(String(top.id)).first() as { id: string; stem: string } | null;
          if (q) review.existing = { id: q.id, stem: q.stem };
        }
      } catch (e) {
        console.warn('[hygiene] suggestion similarity unavailable:', e instanceof Error ? e.message : e);
      }
    }
    return Response.json(review);
  }

  // POST /api/check-similarity - Check text similarity
  if (url.pathname === "/api/check-similarity" && request.method === "POST") {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const rateLimitService = RateLimitService.fromEnv(env);
    const allowed = await rateLimitService.checkLimit(ip, 30, 60, 'check-similarity'); // 30 req/min
    if (!allowed) {
      return new Response("Too Many Requests", { status: 429 });
    }

    // Verify authentication
    const auth = await requireFlexibleAuth(request, env);
    if (!auth.authenticated) {
      return new Response(auth.error || "Unauthorized", { status: 401 });
    }

    try {
      const { text } = await request.json() as { text: string };

      if (!text) {
        return new Response("Missing text", { status: 400 });
      }

      // FIRST: Quick exact-match check in DB (catches true duplicates immediately)
      // This works even before Vectorize has indexed a newly created question
      const normalizedText = text.trim().toLowerCase();
      const exactMatch = await env.DB.prepare(
        `SELECT id, stem, coiner_fid, coiner_fname FROM queries WHERE LOWER(TRIM(stem)) = ? LIMIT 1`
      ).bind(normalizedText).first();

      if (exactMatch) {
        console.log(`[SIMILARITY CHECK] Exact match found in DB for: "${text.substring(0, 50)}..."`);
        return Response.json({
          status: 'duplicate',
          id: exactMatch.id,
          results: [{
            id: exactMatch.id,
            score: 1.0,
            metadata: {
              stem: exactMatch.stem,
              text: exactMatch.stem,
              coiner_fid: exactMatch.coiner_fid,
              coiner_fname: exactMatch.coiner_fname
            }
          }]
        });
      }

      // SECOND: Vector similarity check for near-duplicates
      const vectorService = VectorService.fromEnv(env);
      const result = await vectorService.checkSimilarity(text);

      return Response.json(result);
    } catch (error) {
      console.error("Error checking similarity:", error);
      return new Response("Internal Server Error", { status: 500 });
    }
  }

  // POST /api/parse-query - Parse query text using AI (requires auth)
  if (url.pathname === "/api/parse-query" && request.method === "POST") {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const rateLimitService = RateLimitService.fromEnv(env);
    const allowed = await rateLimitService.checkLimit(ip, 20, 60, 'parse-query'); // 20 req/min
    if (!allowed) {
      return new Response("Too Many Requests", { status: 429 });
    }

    // Verify authentication
    const auth = await requireFlexibleAuth(request, env);
    if (!auth.authenticated) {
      return new Response(auth.error || "Unauthorized", { status: 401 });
    }

    try {
      const { text } = await request.json() as { text: string };

      if (!text) {
        return new Response("Missing text", { status: 400 });
      }

      const aiService = AIService.fromEnv(env);
      const result = await aiService.classifyQuestion(text);

      return Response.json(result);
    } catch (error) {
      console.error("Error parsing query:", error);
      return new Response("Internal Server Error", { status: 500 });
    }
  }

  return null;
}
