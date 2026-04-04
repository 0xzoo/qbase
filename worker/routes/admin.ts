/**
 * Admin API Routes
 * 
 * Handles:
 * - GET /api/beta/check - Check whitelist status
 * - GET /api/admin/beta-whitelist - List whitelisted users
 * - POST /api/admin/beta-whitelist - Add to whitelist (single or bulk)
 * - DELETE /api/admin/beta-whitelist/:fid - Remove from whitelist
 */

import { BetaWhitelistService } from '../services/BetaWhitelistService';
import { requireFlexibleAuth } from '../middleware/auth';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

/**
 * Handle admin-related API routes
 */
export async function handleAdminRoutes(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const pathname = url.pathname;

  // GET /api/beta/check - Check if user is whitelisted for beta access
  // Returns whitelist status for the authenticated user
  if (pathname === "/api/beta/check" && request.method === "GET") {
    try {
      // Verify authentication (flexible: JWT or SIWF)
      const auth = requireFlexibleAuth(request, env);
      if (!auth.authenticated || !auth.fid) {
        return Response.json(
          { whitelisted: false, error: 'Not authenticated' },
          { status: 401 }
        );
      }

      const whitelisted = await BetaWhitelistService.isWhitelisted(env, auth.fid);
      const isAdmin = BetaWhitelistService.isAdmin(auth.fid);

      return Response.json({
        whitelisted,
        isAdmin,
        fid: auth.fid,
      });
    } catch (e) {
      console.error("[Beta] Error checking whitelist:", e);
      return Response.json(
        { error: 'Failed to check whitelist status' },
        { status: 500 }
      );
    }
  }

  // Beta Whitelist Admin endpoints
  if (pathname.startsWith("/api/admin/beta-whitelist")) {
    // All admin endpoints require authentication
    const auth = requireFlexibleAuth(request, env);
    if (!auth.authenticated || !auth.fid) {
      return new Response("Unauthorized", { status: 401 });
    }

    // Only admins can access these endpoints
    if (!BetaWhitelistService.isAdmin(auth.fid)) {
      return new Response("Forbidden: Admin access required", { status: 403 });
    }

    // GET /api/admin/beta-whitelist - List all whitelisted users
    if (pathname === "/api/admin/beta-whitelist" && request.method === "GET") {
      try {
        const limit = parseInt(url.searchParams.get('limit') || '100', 10);
        const offset = parseInt(url.searchParams.get('offset') || '0', 10);

        const result = await BetaWhitelistService.listWhitelist(env, limit, offset);
        return Response.json(result);
      } catch (e) {
        console.error("[Beta Admin] Error listing whitelist:", e);
        return Response.json({ error: 'Failed to list whitelist' }, { status: 500 });
      }
    }

    // POST /api/admin/beta-whitelist - Add user(s) to whitelist
    // Body: { fid?: number, fids?: string (comma-separated), fname?: string, notes?: string }
    // Automatically fetches username from Neynar if not provided
    if (pathname === "/api/admin/beta-whitelist" && request.method === "POST") {
      try {
        const body = await request.json() as {
          fid?: number;
          fids?: string; // Comma-separated list for bulk add
          fname?: string;
          notes?: string;
        };

        // Helper to fetch username from Neynar
        const fetchUsername = async (fid: number): Promise<string | undefined> => {
          try {
            const response = await fetch(
              `https://api.neynar.com/v2/farcaster/user/bulk?fids=${fid}`,
              {
                headers: {
                  "x-api-key": env.NEYNAR_API_KEY,
                  "x-neynar-experimental": "true"
                },
              }
            );
            if (response.ok) {
              const data = await response.json() as { users?: { username?: string }[] };
              return data.users?.[0]?.username;
            }
          } catch (e) {
            console.error(`[Beta Admin] Failed to fetch username for FID ${fid}:`, e);
          }
          return undefined;
        };

        // Bulk add if fids provided
        if (body.fids) {
          const result = await BetaWhitelistService.addBulkToWhitelist(
            env,
            body.fids,
            auth.fid,
            fetchUsername
          );
          return Response.json({
            success: true,
            added: result.added,
            failed: result.failed,
            message: `Added ${result.added.length} FIDs to whitelist`
          });
        }

        // Single add if fid provided
        if (body.fid) {
          // Fetch username from Neynar if not provided
          let fname = body.fname;
          if (!fname) {
            fname = await fetchUsername(body.fid);
          }

          const entry = await BetaWhitelistService.addToWhitelist(
            env,
            body.fid,
            auth.fid,
            fname,
            body.notes
          );
          return Response.json({
            success: true,
            entry,
          });
        }

        return Response.json(
          { error: 'Either fid or fids is required' },
          { status: 400 }
        );
      } catch (e) {
        console.error("[Beta Admin] Error adding to whitelist:", e);
        return Response.json({ error: 'Failed to add to whitelist' }, { status: 500 });
      }
    }

    // DELETE /api/admin/beta-whitelist/:fid - Remove user from whitelist
    const deleteMatch = pathname.match(/^\/api\/admin\/beta-whitelist\/(\d+)$/);
    if (deleteMatch && request.method === "DELETE") {
      try {
        const fid = parseInt(deleteMatch[1], 10);
        const deleted = await BetaWhitelistService.removeFromWhitelist(env, fid);

        return Response.json({
          success: deleted,
          fid,
          message: deleted ? 'Removed from whitelist' : 'User was not in whitelist'
        });
      } catch (e) {
        console.error("[Beta Admin] Error removing from whitelist:", e);
        return Response.json({ error: 'Failed to remove from whitelist' }, { status: 500 });
      }
    }

    return null;
  }

  return null;
}
