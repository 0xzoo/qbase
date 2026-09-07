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
import { EligibilityService } from '../services/EligibilityService';
import { requireFlexibleAuth } from '../middleware/auth';
import { initFarcasterData } from '../services/farcaster';

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
      const auth = await requireFlexibleAuth(request, env);
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
    const auth = await requireFlexibleAuth(request, env);
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

        // Helper to fetch username through the data provider stack
        const fcData = initFarcasterData(env);
        const fetchUsername = async (fid: number): Promise<string | undefined> => {
          try {
            return (await fcData.getUser(fid))?.username;
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

  // GET /api/admin/eligibility?qid=&fid= — debug helper for poll eligibility.
  // Surfaces the result of EligibilityService.checkById so we can confirm
  // gate behavior without going through the answer-create path.
  if (pathname === '/api/admin/eligibility' && request.method === 'GET') {
    const auth = await requireFlexibleAuth(request, env);
    if (!auth.authenticated || !auth.fid) {
      return new Response('Unauthorized', { status: 401 });
    }
    if (!BetaWhitelistService.isAdmin(auth.fid)) {
      return new Response('Forbidden: Admin access required', { status: 403 });
    }

    const qid = url.searchParams.get('qid');
    const fidParam = url.searchParams.get('fid');
    if (!qid || !fidParam) {
      return Response.json({ error: 'qid and fid required' }, { status: 400 });
    }
    const fid = parseInt(fidParam, 10);
    if (!Number.isFinite(fid)) {
      return Response.json({ error: 'fid must be numeric' }, { status: 400 });
    }
    const result = await EligibilityService.checkById(env, qid, fid);
    if (!result) {
      return Response.json({ error: 'query not found' }, { status: 404 });
    }
    return Response.json({ qid, fid, ...result });
  }

  return null;
}
