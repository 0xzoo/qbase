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

  // GET /api/users/me - Get authenticated user's full profile
  if (pathname === "/api/users/me" && request.method === "GET") {
    try {
      const auth = await requireFlexibleAuth(request, env);
      if (!auth.authenticated) {
        return new Response(auth.error || "Unauthorized", { status: 401 });
      }

      let user: any = null;
      if (auth.fid) {
        user = await UserService.getByFid(env, auth.fid);
      } else if (auth.passkeyAddress) {
        user = await UserService.getByQuilAddress(env, auth.passkeyAddress);
      }

      if (!user) {
        return Response.json({ error: 'User not found' }, { status: 404 });
      }

      return Response.json({
        user: {
          id: user.id,
          fid: user.fid,
          quil_address: user.quil_address,
          username: user.username,
          display_name: user.display_name,
          pfp_url: user.pfp_url,
          bio: user.bio,
          profile_source: user.profile_source,
          fname: user.fname,
        },
      });
    } catch (e) {
      console.error('[USERS] GET /api/users/me error:', e);
      return Response.json(
        { error: 'Failed to fetch profile' },
        { status: 500 }
      );
    }
  }

  // POST /api/users/check-username - Real-time username availability check
  if (pathname === "/api/users/check-username" && request.method === "POST") {
    try {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const rateLimitService = RateLimitService.fromEnv(env);
      const allowed = await rateLimitService.checkLimit(ip, 30, 60, 'username:check');
      if (!allowed) {
        return new Response('Too Many Requests', { status: 429 });
      }

      const body = await request.json() as { username?: string };
      if (!body.username) {
        return Response.json({ error: 'Username is required' }, { status: 400 });
      }

      const uname = body.username.toLowerCase().trim();

      // Format validation
      if (uname.length < 3 || uname.length > 20) {
        return Response.json({
          available: false,
          reason: 'Username must be 3-20 characters',
        });
      }
      if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(uname) && !/^[a-z0-9]{3}$/.test(uname)) {
        // Single-hyphen edge: "a-b" is fine (caught by first regex)
        // 3-char alphanumeric: "abc" is fine
        if (!/^[a-z0-9][a-z0-9-]{1,18}[a-z0-9]$/.test(uname)) {
          return Response.json({
            available: false,
            reason: 'Only lowercase letters, numbers, and hyphens (cannot start/end with hyphen)',
          });
        }
      }

      // Reserved words check
      const reserved = new Set([
        'admin', 'system', 'api', 'support', 'qbase', 'moderator', 'root',
        'null', 'undefined', 'constructor', '__proto__', 'localhost',
        'www', 'mail', 'ftp', 'smtp', 'imap', 'dns', 'ssl', 'tls',
      ]);
      if (reserved.has(uname)) {
        return Response.json({
          available: false,
          reason: 'This username is reserved',
        });
      }

      // Uniqueness check
      const existing = await UserService.getByUsername(env, uname);
      if (existing) {
        return Response.json({
          available: false,
          reason: 'Username already taken',
        });
      }

      return Response.json({ available: true });
    } catch (e) {
      console.error('[USERS] check-username error:', e);
      return Response.json({ error: 'Failed to check username' }, { status: 500 });
    }
  }

  // POST /api/users/avatar/upload - Upload avatar to R2
  if (pathname === "/api/users/avatar/upload" && request.method === "POST") {
    try {
      const auth = await requireFlexibleAuth(request, env);
      if (!auth.authenticated) {
        return new Response(auth.error || "Unauthorized", { status: 401 });
      }

      let user: any = null;
      if (auth.fid) {
        user = await UserService.getByFid(env, auth.fid);
      } else if (auth.passkeyAddress) {
        user = await UserService.getByQuilAddress(env, auth.passkeyAddress);
      }

      if (!user) {
        return Response.json({ error: 'User not found' }, { status: 404 });
      }

      // Parse multipart form data
      const contentType = request.headers.get('content-type') || '';
      if (!contentType.includes('multipart/form-data')) {
        return Response.json(
          { error: 'Request must be multipart/form-data' },
          { status: 400 }
        );
      }

      const formData = await request.formData();
      const file = formData.get('avatar') as File | null;

      if (!file) {
        return Response.json({ error: 'No avatar file provided' }, { status: 400 });
      }

      // Validate file type
      const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
      if (!allowedTypes.includes(file.type)) {
        return Response.json(
          { error: 'Only JPEG, PNG, and WebP images are allowed' },
          { status: 400 }
        );
      }

      // Validate file size (max 5MB)
      if (file.size > 5 * 1024 * 1024) {
        return Response.json(
          { error: 'File size must be under 5MB' },
          { status: 400 }
        );
      }

      // Read file bytes
      const bytes = await file.arrayBuffer();

      // Store in R2 at avatars/{user_id}_{timestamp}.{ext}
      const ext = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg';
      const key = `avatars/${user.id}_${Date.now()}.${ext}`;

      await env.R2.put(key, bytes, {
        httpMetadata: {
          contentType: file.type,
          cacheControl: 'public, max-age=31536000, immutable',
        },
      });

      // Build public URL
      // R2 public bucket URL pattern: https://pub-<account>.r2.dev/<key>
      // For now, return a Worker-relative path that can be served or resolved
      const publicUrl = `/r2/${key}`; // served via Worker route below

      // Update user's pfp_url in DB
      await UserService.updateProfile(env, user.id, { pfp_url: publicUrl });

      return Response.json({
        success: true,
        url: publicUrl,
        key,
      });
    } catch (e) {
      console.error('[USERS] avatar upload error:', e);
      return Response.json(
        { error: 'Failed to upload avatar' },
        { status: 500 }
      );
    }
  }

  // GET /r2/* - Serve assets from R2 (public, no auth needed)
  // Covers /r2/avatars/*, /r2/bartlet/*, and any other R2 prefix
  if (pathname.startsWith('/r2/')) {
    const key = pathname.replace('/r2/', '');
    try {
      const object = await env.R2.get(key);
      if (!object) {
        return new Response('Not found', { status: 404 });
      }

      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set('etag', object.httpEtag);
      headers.set('cache-control', 'public, max-age=31536000, immutable');

      return new Response(object.body, {
        status: 200,
        headers,
      });
    } catch (e) {
      console.error('[USERS] R2 serve error:', e);
      return new Response('Not found', { status: 404 });
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
