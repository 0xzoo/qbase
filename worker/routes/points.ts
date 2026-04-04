/**
 * Points API Routes
 * 
 * Handles:
 * - GET /api/points - Get user points
 */

import { PointsService } from '../services/PointsService';
import { RateLimitService } from '../services/RateLimitService';
import { requireFlexibleAuth } from '../middleware/auth';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

/**
 * Handle points-related API routes
 */
export async function handlePointsRoutes(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);

  // User Points endpoints (authenticated)
  if (url.pathname === "/api/points" && request.method === "GET") {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const rateLimitService = RateLimitService.fromEnv(env);
    const allowed = await rateLimitService.checkLimit(ip, 60, 60, 'points'); // 60 req/min
    if (!allowed) {
      return new Response("Too Many Requests", { status: 429 });
    }

    // Verify authentication
    const auth = await requireFlexibleAuth(request, env);
    if (!auth.authenticated) {
      return new Response(auth.error || "Unauthorized", { status: 401 });
    }

    try {
      const pointsService = PointsService.fromEnv(env);
      if (!auth.fid) return new Response('FID not available', { status: 401 });
      const points = await pointsService.getPoints(auth.fid);

      return Response.json(points);
    } catch (error) {
      console.error("Error fetching points:", error);
      return new Response("Internal Server Error", { status: 500 });
    }
  }

  return null;
}
