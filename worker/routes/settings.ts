/**
 * Settings API Routes
 * 
 * Handles:
 * - GET /api/settings - Get settings
 * - PATCH /api/settings - Update settings
 * - DELETE /api/settings - Reset settings
 */

import { UserSettingsService } from '../services/UserSettingsService';
import { RateLimitService } from '../services/RateLimitService';
import { requireFlexibleAuth } from '../middleware/auth';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

/**
 * Handle settings-related API routes
 */
export async function handleSettingsRoutes(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);

  // User Settings endpoints (authenticated)
  if (url.pathname.startsWith("/api/settings")) {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const rateLimitService = RateLimitService.fromEnv(env);
    const allowed = await rateLimitService.checkLimit(ip, 60, 60, 'settings'); // 60 req/min
    if (!allowed) {
      return new Response("Too Many Requests", { status: 429 });
    }

    // Verify authentication
    const auth = await requireFlexibleAuth(request, env);
    if (!auth.authenticated) {
      return new Response(auth.error || "Unauthorized", { status: 401 });
    }

    const settingsService = UserSettingsService.fromEnv(env);

    // GET /api/settings - Get current user's settings
    if (url.pathname === "/api/settings" && request.method === "GET") {
      try {
        if (!auth.fid) return new Response('FID not available', { status: 401 });
      const settings = await settingsService.getSettings(auth.fid);
        return Response.json(settings);
      } catch (error) {
        console.error("Error fetching settings:", error);
        return new Response("Internal Server Error", { status: 500 });
      }
    }

    // PATCH /api/settings - Update current user's settings
    if (url.pathname === "/api/settings" && request.method === "PATCH") {
      try {
        const updates = await request.json() as Record<string, unknown>;
        const settings = await settingsService.updateSettings(auth.fid!, updates);
        return Response.json(settings);
      } catch (error) {
        console.error("Error updating settings:", error);
        return new Response("Internal Server Error", { status: 500 });
      }
    }

    // DELETE /api/settings - Reset current user's settings to defaults
    if (url.pathname === "/api/settings" && request.method === "DELETE") {
      try {
        const settings = await settingsService.resetSettings(auth.fid!);
        return Response.json(settings);
      } catch (error) {
        console.error("Error resetting settings:", error);
        return new Response("Internal Server Error", { status: 500 });
      }
    }
  }

  return null;
}
