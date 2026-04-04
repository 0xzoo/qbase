/**
 * Users API Routes
 * 
 * Handles:
 * - POST /api/users - Create or update user record
 */
import { requireFlexibleAuth } from '../middleware/auth';
import { UserService } from '../services/UserService';
import { BetaWhitelistService } from '../services/BetaWhitelistService';
import { RateLimitService } from '../services/RateLimitService';
import { requireFlexibleAuth } from '../middleware/auth';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

/**
 * Handle users-related API routes
 */
export async function handleUserRoutes(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const pathname = url.pathname;

  // POST /api/users - Create or update user record (requires auth)
  // Body: { fid, fname, displayName?, pfpUrl?, primaryAddress? }
  // This endpoint is called after successful authentication to ensure user exists in DB
  // Supports both JWT (MiniApp) and SIWF (Web) authentication
  if (pathname === "/api/users" && request.method === "POST") {
    try {
      // Verify authentication (flexible: JWT or SIWF)
      const auth = requireFlexibleAuth(request, env);
      if (!auth.authenticated) {
        return new Response(auth.error || "Unauthorized", { status: 401 });
      }

      const body = await request.json() as {
        fid: number;
        fname: string;
        displayName?: string;
        pfpUrl?: string;
        primaryAddress?: string;
      };

      // Verify the authenticated user is creating/updating their own record
      if (body.fid !== auth.fid) {
        return Response.json(
          { error: 'Cannot create/update user record for different FID' },
          { status: 403 }
        );
      }

      // Check if user already exists in DB
      const existingUser = await UserService.getByFid(env, body.fid);

      // If user doesn't exist, check whitelist before creating
      if (!existingUser) {
        const isWhitelisted = await BetaWhitelistService.isWhitelisted(env, body.fid);
        if (!isWhitelisted) {
          return Response.json(
            {
              error: 'Beta access required',
              code: 'BETA_ACCESS_REQUIRED',
              message: 'qbase is currently in beta. You need to be on the whitelist to create an account.'
            },
            { status: 403 }
          );
        }
      }

      // Upsert user
      const user = await UserService.upsert(env, {
        fid: body.fid,
        fname: body.fname,
        displayName: body.displayName,
        pfpUrl: body.pfpUrl,
        primaryAddress: body.primaryAddress,
      });

      return Response.json({
        success: true,
        user: {
          id: user.id,
          fid: user.fid,
          fname: user.fname,
          created_at: user.created_at,
        }
      });
    } catch (e) {
      console.error("Error creating/updating user:", e);
      return Response.json(
        { error: 'Failed to create/update user' },
        { status: 500 }
      );
    }
  }

  // GET /api/user/search - Search for users by fname
  if (url.pathname === '/api/user/search' && request.method === 'GET') {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const rateLimitService = RateLimitService.fromEnv(env);
    const allowed = await rateLimitService.checkLimit(ip, 60, 60, 'user:search');
    if (!allowed) {
      return new Response('Too Many Requests', { status: 429 });
    }

    try {
      const query = url.searchParams.get('q');
      if (!query || query.length < 1) {
        return Response.json({ users: [] });
      }

      const limit = Math.min(parseInt(url.searchParams.get('limit') || '10'), 20);

      const { results } = await env.DB.prepare(
        `SELECT fid, fname, display_name, pfp_url 
         FROM Users 
         WHERE LOWER(fname) LIKE ? 
         ORDER BY fname ASC 
         LIMIT ?`
      ).bind(`${query.toLowerCase()}%`, limit).all();

      return Response.json({ users: results || [] });
    } catch (error) {
      console.error('Error searching users:', error);
      return Response.json({ users: [] });
    }
  }

  return null;
}
