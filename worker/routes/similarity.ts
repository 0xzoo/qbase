/**
 * Similarity and Query Parsing API Routes
 * 
 * Handles:
 * - POST /api/check-similarity - Check text similarity (vector + exact match)
 * - POST /api/parse-query - Parse query text using AI
 */

import { VectorService } from '../services/VectorService';
import { AIService } from '../services/AIService';
import { RateLimitService } from '../services/RateLimitService';
import { requireFlexibleAuth } from '../middleware/auth';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

/**
 * Handle similarity and query parsing API routes
 */
export async function handleSimilarityRoutes(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);

  // POST /api/check-similarity - Check text similarity
  if (url.pathname === "/api/check-similarity" && request.method === "POST") {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const rateLimitService = RateLimitService.fromEnv(env);
    const allowed = await rateLimitService.checkLimit(ip, 20, 60, 'check-similarity'); // 20 req/min
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
      const result = await aiService.parseQuery(text);

      return Response.json(result);
    } catch (error) {
      console.error("Error parsing query:", error);
      return new Response("Internal Server Error", { status: 500 });
    }
  }

  return null;
}
