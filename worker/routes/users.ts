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
      const auth = await requireFlexibleAuth(request, env);
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

  // PATCH /api/users/profile - Update own profile (native identity fields)
  if (pathname === "/api/users/profile" && request.method === "PATCH") {
    try {
      const auth = await requireFlexibleAuth(request, env);
      if (!auth.authenticated) {
        return new Response(auth.error || "Unauthorized", { status: 401 });
      }

      const body = await request.json() as {
        username?: string;
        display_name?: string;
        pfp_url?: string;
        bio?: string;
      };

      // Validate username format if provided
      if (body.username !== undefined) {
        const uname = body.username.toLowerCase().trim();
        if (uname.length < 3 || uname.length > 20 || !/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(uname)) {
          return Response.json(
            { error: 'Username must be 3-20 characters, lowercase alphanumeric and hyphens only' },
            { status: 400 }
          );
        }
        // Check uniqueness
        const existing = await UserService.getByUsername(env, uname);
        if (existing) {
          // Resolve the caller's user ID to check if it's the same user
          let callerId: number | null = null;
          if (auth.fid) {
            const caller = await UserService.getByFid(env, auth.fid);
            callerId = caller?.id || null;
          } else if (auth.passkeyAddress) {
            const caller = await UserService.getByQuilAddress(env, auth.passkeyAddress);
            callerId = caller?.id || null;
          }
          if (existing.id !== callerId) {
            return Response.json(
              { error: 'Username already taken' },
              { status: 409 }
            );
          }
        }
        body.username = uname;
      }

      // Validate bio length
      if (body.bio !== undefined && body.bio.length > 280) {
        return Response.json(
          { error: 'Bio must be 280 characters or less' },
          { status: 400 }
        );
      }

      // Resolve user ID from auth
      let user: any = null;
      if (auth.fid) {
        user = await UserService.getByFid(env, auth.fid);
      } else if (auth.passkeyAddress) {
        user = await UserService.getByQuilAddress(env, auth.passkeyAddress);
      }

      if (!user) {
        return Response.json({ error: 'User not found' }, { status: 404 });
      }

      const updated = await UserService.updateProfile(env, user.id, body);
      return Response.json({
        success: true,
        user: updated ? {
          id: updated.id,
          username: updated.username,
          display_name: updated.display_name,
          pfp_url: updated.pfp_url,
          bio: updated.bio,
          profile_source: updated.profile_source,
        } : null,
      });
    } catch (e) {
      console.error('[USERS] Profile update error:', e);
      return Response.json(
        { error: 'Failed to update profile' },
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
