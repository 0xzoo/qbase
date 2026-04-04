/**
 * Miniapp API Routes
 * 
 * Handles:
 * - GET /api/miniapp/status - Check if user added miniapp
 * - POST /api/miniapp/status - Update miniapp status
 * - GET /api/miniapp/notifications - Check notification status
 * - POST /api/miniapp/notifications - Update notification status
 */

import { RateLimitService } from '../services/RateLimitService';
import { requireFlexibleAuth } from '../middleware/auth';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

/**
 * Handle miniapp-related API routes
 */
export async function handleMiniappRoutes(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);

  // Miniapp Status endpoints (authenticated)
  if (url.pathname === "/api/miniapp/status") {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const rateLimitService = RateLimitService.fromEnv(env);
    const allowed = await rateLimitService.checkLimit(ip, 60, 60, 'miniapp:status'); // 60 req/min
    if (!allowed) {
      return new Response("Too Many Requests", { status: 429 });
    }

    // Verify authentication
    const auth = await requireFlexibleAuth(request, env);
    if (!auth.authenticated) {
      return new Response(auth.error || "Unauthorized", { status: 401 });
    }

    // GET /api/miniapp/status - Check if user has added miniapp
    if (request.method === "GET") {
      try {
        const key = `miniapp_added:${auth.fid}`;
        const value = await env.KV_USER_PROFILES.get(key);
        const miniAppAdded = value === 'true';

        return Response.json({ miniAppAdded });
      } catch (error) {
        console.error("Error checking miniapp status:", error);
        return new Response("Internal Server Error", { status: 500 });
      }
    }

    // POST /api/miniapp/status - Update miniapp add/remove status
    if (request.method === "POST") {
      try {
        const body = await request.json();
        const { added } = body as { added: boolean };

        const key = `miniapp_added:${auth.fid}`;
        await env.KV_USER_PROFILES.put(key, added ? 'true' : 'false');

        console.log(`Marked miniapp as ${added ? 'added' : 'removed'} for FID ${auth.fid}`);

        return Response.json({ success: true, miniAppAdded: added });
      } catch (error) {
        console.error("Error updating miniapp status:", error);
        return new Response("Internal Server Error", { status: 500 });
      }
    }

    return new Response("Method Not Allowed", { status: 405 });
  }

  // Miniapp Notification Status endpoints (authenticated)
  if (url.pathname === "/api/miniapp/notifications") {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const rateLimitService = RateLimitService.fromEnv(env);
    const allowed = await rateLimitService.checkLimit(ip, 60, 60, 'miniapp:notifications'); // 60 req/min
    if (!allowed) {
      return new Response("Too Many Requests", { status: 429 });
    }

    // Verify authentication
    const auth = await requireFlexibleAuth(request, env);
    if (!auth.authenticated) {
      return new Response(auth.error || "Unauthorized", { status: 401 });
    }

    // GET /api/miniapp/notifications - Check if user has notifications enabled
    if (request.method === "GET") {
      try {
        const key = `notifications_enabled:${auth.fid}`;
        const value = await env.KV_USER_PROFILES.get(key);
        const notificationsEnabled = value === 'true';

        return Response.json({ notificationsEnabled });
      } catch (error) {
        console.error("Error checking notification status:", error);
        return new Response("Internal Server Error", { status: 500 });
      }
    }

    // POST /api/miniapp/notifications - Update notification enabled/disabled status
    if (request.method === "POST") {
      try {
        const body = await request.json();
        const { enabled } = body as { enabled: boolean };

        const key = `notifications_enabled:${auth.fid}`;
        await env.KV_USER_PROFILES.put(key, enabled ? 'true' : 'false');

        console.log(`Marked notifications as ${enabled ? 'enabled' : 'disabled'} for FID ${auth.fid}`);

        return Response.json({ success: true, notificationsEnabled: enabled });
      } catch (error) {
        console.error("Error updating notification status:", error);
        return new Response("Internal Server Error", { status: 500 });
      }
    }

    return new Response("Method Not Allowed", { status: 405 });
  }

  return null;
}
