/**
 * Users API Routes
 *
 * Handles:
 * - GET  /api/users/by-handle/:handle      qbase profile by handle (any sign-in method)
 * - GET  /api/users/by-username/:username  Server-side Neynar profile lookup
 * - POST /api/users/check-username         Handle availability (HandleService rules)
 * - POST /api/users                        Create or update user record
 * - PATCH /api/users/profile               Update own native profile fields
 * - GET  /api/users/me                     Signed-in user's profile
 * - GET  /api/users/account/:accountId     Public profile by person key (accounts with no Farcaster)
 *
 * Profile responses carry `account_id` (the person key, = Users.fid column) and
 * `fid` (the linked Farcaster fid, or null). Before the account cutover they
 * are the same number (docs/specs/account-root.md).
 */
import { requireFlexibleAuth, type AuthResult } from '../middleware/auth';
import { UserService, type User } from '../services/UserService';
import { farcasterFidOf } from '../services/accounts/AccountService';
import { checkHandle, HANDLE_LOOKUP_PATTERN, normalizeHandle } from '../services/accounts/HandleService';
import { ACCOUNT_ID_MIN } from '../services/accounts/migrationSql';
import { BetaWhitelistService } from '../services/BetaWhitelistService';
import { RateLimitService } from '../services/RateLimitService';
import { initFarcasterData, type FarcasterUser } from '../services/farcaster';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

const PROFILE_BY_USERNAME_TTL = 300; // 5 minutes

/**
 * The signed-in person's Users row: by person key, else (a passkey session
 * whose key is not resolvable yet) by the passkey's quil_address.
 */
async function getSelf(env: Env, auth: AuthResult): Promise<User | null> {
  if (auth.userKey !== undefined) return UserService.getByFid(env, auth.userKey);
  if (auth.passkeyAddress) return UserService.getByQuilAddress(env, auth.passkeyAddress);
  return null;
}

/**
 * The Farcaster fid of a Users row (keyed by `key`), or null. The legacy
 * passkey rows carry negative keys, which are not fids.
 */
async function farcasterFidForKey(env: Env, key: number, authFid?: number): Promise<number | null> {
  if (authFid) return authFid;
  const fid = await farcasterFidOf(env, key);
  return fid !== undefined && fid > 0 ? fid : null;
}

/**
 * Handle users-related API routes
 */
export async function handleUserRoutes(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const pathname = url.pathname;

  // GET /api/users/by-handle/:handle — a qbase profile by handle (HandleService),
  // whatever the account signed in with. Placeholder rows (bots, legacy keys)
  // are not accounts and are not served here; /ask/ falls back to the
  // Farcaster lookup below for them and for Farcaster users not on qbase.
  const byHandleMatch = pathname.match(/^\/api\/users\/by-handle\/([^/]+)$/);
  if (byHandleMatch && request.method === "GET") {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const allowed = await RateLimitService.fromEnv(env).checkLimit(ip, 60, 60, 'users:by-handle');
    if (!allowed) return new Response("Too Many Requests", { status: 429 });

    const handle = normalizeHandle(decodeURIComponent(byHandleMatch[1]));
    if (!HANDLE_LOOKUP_PATTERN.test(handle)) {
      return Response.json({ error: 'Invalid handle' }, { status: 400 });
    }
    try {
      const row = await env.DB.prepare(
        `SELECT fid, username, display_name, pfp_url, bio, created_at FROM Users WHERE username = ? AND fid >= ?`,
      ).bind(handle, ACCOUNT_ID_MIN).first() as {
        fid: number; username: string; display_name: string | null; pfp_url: string | null; bio: string | null; created_at: string | number | null;
      } | null;
      if (!row) return Response.json({ error: 'User not found' }, { status: 404 });

      const accountId = Number(row.fid);
      const fid = await farcasterFidForKey(env, accountId);
      let farcaster: FarcasterUser | null = null;
      if (fid) {
        const cacheKey = `fc_profile_by_fid:${fid}`;
        try {
          const cached = await env.KV_USER_PROFILES.get(cacheKey);
          if (cached) farcaster = JSON.parse(cached) as FarcasterUser;
        } catch { /* fall through */ }
        if (!farcaster) {
          try {
            farcaster = await initFarcasterData(env).getUser(fid, { need: ['power_badge'] });
            if (farcaster) {
              farcaster.profile ??= { bio: { text: '' } };
              farcaster.profile.bio ??= { text: '' };
              await env.KV_USER_PROFILES.put(cacheKey, JSON.stringify(farcaster), { expirationTtl: PROFILE_BY_USERNAME_TTL }).catch(() => {});
            }
          } catch (err) {
            console.warn('[users] by-handle Farcaster enrich failed:', err);
          }
        }
      }

      return Response.json({
        profile: {
          account_id: accountId,
          handle: row.username,
          display_name: row.display_name || farcaster?.display_name || row.username,
          pfp_url: row.pfp_url || farcaster?.pfp_url || null,
          bio: row.bio ?? farcaster?.profile?.bio?.text ?? null,
          created_at: row.created_at,
          fid,
          farcaster,
        },
      });
    } catch (e) {
      console.error('[USERS] GET /api/users/by-handle error:', e);
      return Response.json({ error: 'Failed to fetch profile' }, { status: 500 });
    }
  }

  // GET /api/users/by-username/:username — server-side profile lookup through
  // the Farcaster data provider stack (Neynar → hub). Replaces a client-side
  // call that would have exposed VITE_NEYNAR_API_KEY in the browser bundle.
  // Cached briefly in KV so a profile-page hit doesn't burn quota on every navigation.
  const byUsernameMatch = pathname.match(/^\/api\/users\/by-username\/([^/]+)$/);
  if (byUsernameMatch && request.method === "GET") {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const allowed = await RateLimitService.fromEnv(env).checkLimit(ip, 60, 60, 'users:by-username');
    if (!allowed) return new Response("Too Many Requests", { status: 429 });

    const username = decodeURIComponent(byUsernameMatch[1]).toLowerCase().trim();
    if (!username || !/^[a-z0-9][a-z0-9._-]{0,32}$/.test(username)) {
      return Response.json({ error: 'Invalid username' }, { status: 400 });
    }
    const cacheKey = `neynar_profile:${username}`;
    try {
      const cached = await env.KV_USER_PROFILES.get(cacheKey);
      if (cached) {
        return new Response(cached, {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    } catch { /* KV pressure — fall through to live fetch */ }

    let user: FarcasterUser | null;
    try {
      // The profile page renders `power_badge` (Neynar-only) — enrich it when Haatz answered first.
      user = await initFarcasterData(env).getUserByUsername(username, { need: ['power_badge'] });
    } catch (err) {
      console.error('[users] profile lookup threw:', err);
      return Response.json({ error: 'Upstream unavailable' }, { status: 502 });
    }
    if (!user) {
      // Providers miss some usernames, notably ENS-style fnames ("name.eth").
      // Fall back to the fid qbase already knows for that name.
      try {
        const known = await env.DB.prepare(
          `SELECT CAST(c.value AS INTEGER) AS fid FROM account_credentials c
            WHERE c.kind = 'farcaster' AND lower(c.label) = ?
           UNION ALL
           SELECT CAST(c.value AS INTEGER) FROM Users u
             JOIN account_credentials c ON c.account_id = u.fid AND c.kind = 'farcaster'
            WHERE lower(u.fname) = ?
           LIMIT 1`,
        ).bind(username, username).first() as { fid: number } | null;
        if (known?.fid) user = await initFarcasterData(env).getUser(Number(known.fid), { need: ['power_badge'] });
      } catch (err) {
        console.warn('[users] username fallback failed:', err);
      }
    }
    if (!user) {
      return Response.json({ error: 'User not found' }, { status: 404 });
    }
    // The profile page reads `profile.bio.text` unguarded; hub-sourced users may lack a bio.
    user.profile ??= { bio: { text: '' } };
    user.profile.bio ??= { text: '' };

    const body = JSON.stringify({ user });
    try {
      await env.KV_USER_PROFILES.put(cacheKey, body, { expirationTtl: PROFILE_BY_USERNAME_TTL });
    } catch { /* cache write best effort */ }

    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

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

      // This endpoint syncs a Farcaster profile: body.fid is the Farcaster fid.
      if (!auth.fid) {
        return Response.json({ error: 'farcaster_required' }, { status: 409 });
      }
      if (auth.userKey === undefined) {
        return new Response("Unauthorized", { status: 401 });
      }
      const userKey = auth.userKey;

      // Verify the authenticated user is creating/updating their own record
      if (body.fid !== auth.fid) {
        return Response.json(
          { error: 'Cannot create/update user record for different FID' },
          { status: 403 }
        );
      }

      // Check if user already exists in DB
      const existingUser = await UserService.getByFid(env, userKey);

      // If user doesn't exist, check whitelist before creating
      // (beta_whitelist is a Farcaster allowlist: stays keyed by fid)
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
        fid: userKey,
        fname: body.fname,
        displayName: body.displayName,
        pfpUrl: body.pfpUrl,
        primaryAddress: body.primaryAddress,
      });

      return Response.json({
        success: true,
        user: {
          id: user.id,
          account_id: user.id,
          fid: auth.fid,
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

      // The username is the handle (HandleService): same rules as the picker.
      if (body.username !== undefined) {
        const caller = await getSelf(env, auth);
        const verdict = await checkHandle(env, body.username, caller?.id ?? null);
        if (!verdict.ok) {
          return Response.json(
            { error: verdict.reason, code: verdict.code },
            { status: verdict.code === 'invalid' || verdict.code === 'reserved' ? 400 : 409 }
          );
        }
        body.username = verdict.handle;
      }

      // Validate bio length
      if (body.bio !== undefined && body.bio.length > 280) {
        return Response.json(
          { error: 'Bio must be 280 characters or less' },
          { status: 400 }
        );
      }

      // Resolve user ID from auth
      const user = await getSelf(env, auth);

      if (!user) {
        return Response.json({ error: 'User not found' }, { status: 404 });
      }

      let updated;
      try {
        updated = await UserService.updateProfile(env, user.id, body);
      } catch (e) {
        if (String((e as Error)?.message ?? e).includes('UNIQUE')) {
          return Response.json({ error: 'Handle already taken', code: 'taken' }, { status: 409 });
        }
        throw e;
      }
      return Response.json({
        success: true,
        user: updated ? {
          id: updated.id,
          account_id: updated.id,
          fid: await farcasterFidForKey(env, updated.id, auth.fid),
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

      const user = await getSelf(env, auth);

      if (!user) {
        return Response.json({ error: 'User not found' }, { status: 404 });
      }

      return Response.json({
        user: {
          id: user.id,
          account_id: user.id,
          fid: await farcasterFidForKey(env, user.id, auth.fid),
          quil_address: user.quil_address,
          username: user.username,
          handle: user.username || null,
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

  // GET /api/users/account/:accountId - Public profile by person key (the
  // Users.fid column). For accounts with no Farcaster fid; before the cutover
  // the person key is the fid, so a fid works here too.
  const byAccountMatch = pathname.match(/^\/api\/users\/account\/(\d+)$/);
  if (byAccountMatch && request.method === "GET") {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const allowed = await RateLimitService.fromEnv(env).checkLimit(ip, 60, 60, 'users:by-account');
    if (!allowed) return new Response("Too Many Requests", { status: 429 });

    const key = Number(byAccountMatch[1]);
    if (!Number.isSafeInteger(key) || key <= 0) {
      return Response.json({ error: 'Invalid account id' }, { status: 400 });
    }
    try {
      const user = await UserService.getByFid(env, key);
      if (!user) {
        return Response.json({ error: 'User not found' }, { status: 404 });
      }
      return Response.json({
        user: {
          id: user.id,
          account_id: user.id,
          fid: await farcasterFidForKey(env, user.id),
          username: user.username,
          handle: user.username || null,
          fname: user.fname,
          display_name: user.display_name,
          pfp_url: user.pfp_url,
          bio: user.bio,
          profile_source: user.profile_source,
          pro_status: user.pro_status,
          created_at: user.created_at,
        },
      });
    } catch (e) {
      console.error('[USERS] GET /api/users/account/:accountId error:', e);
      return Response.json({ error: 'Failed to fetch profile' }, { status: 500 });
    }
  }

  // POST /api/users/check-username - Real-time username availability check
  if (pathname === "/api/users/check-username" && request.method === "POST") {
    try {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const allowed = await RateLimitService.fromEnv(env).checkLimit(ip, 30, 60, 'username:check');
      if (!allowed) {
        return new Response('Too Many Requests', { status: 429 });
      }

      const body = await request.json() as { username?: string };
      if (!body.username) {
        return Response.json({ error: 'Username is required' }, { status: 400 });
      }
      // Signed in: your own current handle counts as available.
      const auth = await requireFlexibleAuth(request, env);
      const caller = auth.authenticated ? await getSelf(env, auth) : null;
      const verdict = await checkHandle(env, body.username, caller?.id ?? null);
      return Response.json(verdict.ok
        ? { available: true, handle: verdict.handle }
        : { available: false, handle: verdict.handle, code: verdict.code, reason: verdict.reason });
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

      const user = await getSelf(env, auth);

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

      // Users.fid is the person key: expose it as account_id, and fid as the
      // linked Farcaster fid (identical before the cutover).
      const users = await Promise.all(((results || []) as Array<{ fid: number } & Record<string, unknown>>).map(async (u) => ({
        ...u,
        account_id: u.fid,
        fid: await farcasterFidForKey(env, Number(u.fid)),
      })));
      return Response.json({ users });
    } catch (error) {
      console.error('Error searching users:', error);
      return Response.json({ users: [] });
    }
  }

  return null;
}
