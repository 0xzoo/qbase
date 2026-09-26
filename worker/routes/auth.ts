/**
 * Auth API Routes
 * 
 * Handles:
 * - POST /api/auth/session - SIWF session creation
 * - POST /api/auth/passkey/register - Register a new passkey user + credential
 * - POST /api/auth/passkey/login - Login with existing passkey (Ed448 challenge/response)
 * - GET /api/auth/passkey/challenge - Get a server-issued challenge for login
 * - GET /api/auth/passkey/user - Get current passkey user info (requires auth)
 */

import { AuthService } from '../services/AuthService';
import { requireFlexibleAuth } from '../middleware/auth';
import { RateLimitService } from '../services/RateLimitService';
import { initFarcasterData } from '../services/farcaster';
import { AccountError, userKeyForFid, userKeyForPasskey } from '../services/accounts/AccountService';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

/**
 * Per-IP rate limit gate. Returns a 429 Response when over budget, or null
 * to let the caller continue. KV-backed via RateLimitService — eventual
 * consistency means tight bursts can race past the cap, but for auth this
 * still cuts off naive brute-force.
 */
async function rateGate(
  request: Request,
  env: Env,
  endpoint: string,
  limit: number,
  windowSeconds = 60,
): Promise<Response | null> {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const allowed = await RateLimitService.fromEnv(env).checkLimit(ip, limit, windowSeconds, endpoint);
  if (!allowed) {
    return new Response('Too Many Requests', { status: 429 });
  }
  return null;
}

/**
 * Refresh user avatar in KV cache
 * Called at session start to keep avatars fresh without constant API calls
 * Strategy: Refresh avatar when user logs in (every ~7 days), cache for 24 hours between refreshes
 */
async function refreshUserAvatar(env: Env, fid: number): Promise<void> {
  const cacheKey = `user_pfp:${fid}`;

  try {
    // Fetch fresh avatar through the data provider stack (Neynar → hub)
    const avatarUrl = await initFarcasterData(env).getAvatarUrl(fid);

    if (avatarUrl) {
      // Cache for 24 hours
      await env.KV_USER_PROFILES.put(cacheKey, avatarUrl, {
        expirationTtl: 86400 // 24 hours
      });
      console.log(`[AUTH] ✅ Refreshed avatar for FID ${fid}`);
    } else {
      console.warn(`[AUTH] No avatar resolved for FID ${fid}`);
    }
  } catch (error) {
    console.error(`[AUTH] Error refreshing avatar for FID ${fid}:`, error);
    // Don't throw - avatar refresh is non-critical
  }
}

/**
 * Handle auth-related API routes
 */
export async function handleAuthRoutes(
  request: Request,
  env: Env,
  ctx?: { waitUntil: (p: Promise<any>) => void }
): Promise<Response | null> {
  const url = new URL(request.url);
  const pathname = url.pathname;

  // GET /api/auth/nonce - Generate a single-use nonce for SIWF.
  // Stored in KV with a 10min TTL so /api/auth/session can confirm the
  // signed message references a nonce we actually issued. SIWF library
  // already binds the nonce into the signature; this layer adds replay
  // protection by consuming the nonce on first redeem.
  if (pathname === "/api/auth/nonce" && request.method === "GET") {
    const limited = await rateGate(request, env, 'auth:nonce', 60);
    if (limited) return limited;
    const nonce = crypto.randomUUID().replace(/-/g, '');
    try {
      await env.KV_USER_PROFILES.put(`siwf_nonce:${nonce}`, '1', { expirationTtl: 600 });
    } catch (err) {
      console.error('[AUTH] Failed to persist nonce:', err);
      return Response.json({ error: 'Failed to issue nonce' }, { status: 500 });
    }
    return Response.json({ nonce });
  }

  // POST /api/auth/session - Exchange SIWF credentials for a session token.
  // Body: { message, signature, nonce }
  // Single-use nonce: must have been issued by /api/auth/nonce within the
  // last 10 minutes and not yet redeemed. Consumed (deleted) before
  // verification so a failed signature still burns the nonce — prevents a
  // slow brute-force replaying many candidate signatures against one nonce.
  if (pathname === "/api/auth/session" && request.method === "POST") {
    const limited = await rateGate(request, env, 'auth:session', 10);
    if (limited) return limited;
    try {
      const body = await request.json() as {
        message: string;
        signature: string;
        nonce: string;
      };

      console.log(`[AUTH] Session creation request - nonce: ${body.nonce.substring(0, 8)}...`);

      // Consume the nonce. If it's not in KV (never issued, expired, or
      // already redeemed), reject. KV is eventually consistent, so two
      // concurrent redeems of the same legitimate request can both pass —
      // acceptable here because both come from the same client with the
      // same signature.
      const nonceKey = `siwf_nonce:${body.nonce}`;
      const nonceMarker = await env.KV_USER_PROFILES.get(nonceKey);
      if (!nonceMarker) {
        console.warn(`[AUTH] Session rejected — unknown or used nonce ${body.nonce.substring(0, 8)}...`);
        return Response.json({ error: 'Nonce expired or already used' }, { status: 401 });
      }
      await env.KV_USER_PROFILES.delete(nonceKey);

      // Verify SIWF credentials
      const authService = AuthService.fromEnv(env, request.url);
      const result = await authService.verifySIWFMessage({
        message: body.message,
        signature: body.signature,
        nonce: body.nonce,
      });

      if (!result.success || !result.fid) {
        console.error(`[AUTH] Session creation failed for nonce ${body.nonce.substring(0, 8)}...: ${result.error}`);
        return Response.json(
          { error: result.error || 'Invalid credentials' },
          { status: 401 }
        );
      }

      // Create a session token (valid for 7 days)
      const sessionToken = crypto.randomUUID();
      const expiresAt = Date.now() + (7 * 24 * 60 * 60 * 1000); // 7 days

      // Store session in KV
      await env.KV_USER_PROFILES.put(
        `session:${sessionToken}`,
        JSON.stringify({ fid: result.fid, expiresAt }),
        { expirationTtl: 7 * 24 * 60 * 60 } // 7 days
      );

      console.log(`[AUTH] ✅ Created session for FID ${result.fid}`);

      // Refresh avatar at session start (background task)
      // This keeps avatars fresh without constant API calls
      if (ctx?.waitUntil) {
        ctx.waitUntil(refreshUserAvatar(env, result.fid));
      } else {
        refreshUserAvatar(env, result.fid).catch(err => {
          console.error(`[AUTH] Avatar refresh failed for FID ${result.fid}:`, err);
        });
      }

      return Response.json({
        sessionToken,
        account_id: await userKeyForFid(env, result.fid).catch((err) => {
          console.warn('[AUTH] account resolution failed at session start:', err);
          return null;
        }),
        fid: result.fid,
        expiresAt,
      });
    } catch (e) {
      console.error("[AUTH] Error creating session:", e);
      return Response.json(
        { error: 'Failed to create session' },
        { status: 500 }
      );
    }
  }

  // POST /api/auth/passkey/register - Register a new passkey user + credential
  if (pathname === "/api/auth/passkey/register" && request.method === "POST") {
    const limited = await rateGate(request, env, 'auth:passkey:register', 5);
    if (limited) return limited;
    try {
      const body = await request.json() as {
        address: string;
        // Client may send number[] (current shape) or string (legacy);
        // PasskeyAuthService.register normalizes before binding.
        publicKey: string | number[];
        displayName?: string;
        credentialId: string;
        registrationData: unknown;
        deviceName?: string;
        fid?: number;
      };

      if (!body.address || !body.publicKey || !body.credentialId || !body.registrationData) {
        return Response.json(
          { error: 'Missing required fields: address, publicKey, credentialId, registrationData' },
          { status: 400 }
        );
      }

      // If FID provided, seed profile from Neynar at registration time (one-time)
      let seedFname: string | undefined;
      let seedPfpUrl: string | undefined;
      let seedDisplayName = body.displayName;
      if (body.fid) {
        try {
          const profile = await initFarcasterData(env).getUser(body.fid);
          if (profile) {
            seedFname = profile.username;
            seedPfpUrl = profile.pfp_url;
            seedDisplayName = profile.display_name || seedDisplayName;
            console.log(`[PASSKEY] Seeded profile from FC for FID ${body.fid}: ${seedFname}`);
          }
        } catch (err) {
          console.warn(`[PASSKEY] profile seed failed for FID ${body.fid}:`, err);
        }
      }

      const { PasskeyAuthService } = await import('../services/PasskeyAuthService');
      const result = await PasskeyAuthService.register(env, {
        address: body.address,
        publicKey: body.publicKey,
        displayName: seedDisplayName,
        credentialId: body.credentialId,
        registrationData: body.registrationData,
        deviceName: body.deviceName,
        fid: body.fid,
      });

      // Also seed the users table with profile data
      if (result.isNewUser && body.fid) {
        try {
          await env.DB.prepare(
            'UPDATE users SET pfp_url = ?, display_name = ?, username = COALESCE(username, ?), profile_source = ? WHERE quil_address = ?'
          ).bind(
            seedPfpUrl || null,
            seedDisplayName || null,
            seedFname || null,
            'farcaster',
            body.address
          ).run();
        } catch (err) {
          console.warn('[PASSKEY] Failed to seed users profile:', err);
        }
      } else if (result.isNewUser) {
        // Passkey-only user (no FID)
        try {
          await env.DB.prepare(
            "UPDATE users SET profile_source = 'passkey' WHERE quil_address = ?"
          ).bind(body.address).run();
        } catch (err) {
          console.warn('[PASSKEY] Failed to set profile_source:', err);
        }
      }

      return Response.json({
        success: true,
        sessionToken: result.sessionToken,
        address: result.address,
        quilAddress: result.address,
        isNewUser: result.isNewUser,
      });
    } catch (e) {
      if (e instanceof AccountError) {
        return Response.json({ error: e.code }, { status: e.status });
      }
      console.error('[PASSKEY] Registration error:', e);
      return Response.json(
        { error: 'Failed to register passkey' },
        { status: 500 }
      );
    }
  }

  // ── POST /api/auth/passkey/link ──
  // Link a passkey to an existing FC session (called from onboarding or settings)
  // Requires valid FC session token, creates a passkey registration linked to that FID
  if (pathname === "/api/auth/passkey/link" && request.method === "POST") {
    const limited = await rateGate(request, env, 'auth:passkey:link', 5);
    if (limited) return limited;
    try {
      const auth = await requireFlexibleAuth(request, env);
      if (!auth.authenticated) {
        return Response.json({ error: 'Must be authenticated with a session token' }, { status: 401 });
      }
      // passkey_users.fid is the linked Farcaster fid (a Farcaster fact, not a person key).
      if (!auth.fid) {
        return Response.json({ error: 'farcaster_required' }, { status: 409 });
      }

      const body = await request.json() as {
        address: string;
        // Client sends number[] (per StoredPasskey.publicKey); register
        // normalizes before binding.
        publicKey: string | number[];
        credentialId: string;
        registrationData: unknown;
        displayName?: string;
      };

      if (!body.address || !body.credentialId) {
        return Response.json({ error: 'Missing address or credentialId' }, { status: 400 });
      }

      const { PasskeyAuthService } = await import('../services/PasskeyAuthService');
      const result = await PasskeyAuthService.register(env, {
        address: body.address,
        publicKey: body.publicKey,
        displayName: body.displayName,
        credentialId: body.credentialId,
        registrationData: body.registrationData,
        fid: auth.fid,
      });

      // Update the existing session to include the passkey address
      const token = request.headers.get('Authorization')?.split(' ')[1];
      if (token) {
        await env.KV_USER_PROFILES.put(
          `session:${token}`,
          JSON.stringify({ fid: auth.fid, passkeyAddress: body.address, quilAddress: body.address, expiresAt: Date.now() + (7 * 24 * 60 * 60 * 1000) }),
          { expirationTtl: 7 * 24 * 60 * 60 }
        );
        console.log(`[PASSKEY] ✅ Updated session ${token.substring(0, 8)}... with passkey address ${body.address.substring(0, 12)}...`);
      }

      return Response.json({
        success: true,
        address: result.address,
        quilAddress: result.address,
      });
    } catch (e) {
      console.error('[PASSKEY] Link error:', e);
      return Response.json({ error: 'Failed to link passkey' }, { status: 500 });
    }
  }
  // GET /api/auth/passkey/challenge?address=… (or ?credentialId=…)
  // Issues a one-time challenge bound to the address that the client must sign
  // with their Ed448 private key. Stored in KV with a 5-minute TTL.
  // The credentialId form is provided so the discoverable-credential login flow
  // can resolve to an address without leaking it (response includes the address
  // only for the caller — not a generally readable lookup since it requires
  // possession of the credentialId, which is itself a capability).
  if (pathname === "/api/auth/passkey/challenge" && request.method === "GET") {
    const limited = await rateGate(request, env, 'auth:passkey:challenge', 30);
    if (limited) return limited;
    try {
      let address = url.searchParams.get('address') || undefined;
      const credentialId = url.searchParams.get('credentialId') || undefined;
      if (!address && !credentialId) {
        return Response.json({ error: 'Missing address or credentialId' }, { status: 400 });
      }

      const { PasskeyAuthService } = await import('../services/PasskeyAuthService');
      if (!address && credentialId) {
        const resolved = await PasskeyAuthService.resolveAddressByCredentialId(env, credentialId);
        if (!resolved) {
          return Response.json({ error: 'Unknown credential' }, { status: 404 });
        }
        address = resolved;
      }

      const challenge = await PasskeyAuthService.issueChallenge(env, address!);
      if (!challenge) {
        // Address not registered. Return 404 only when the caller asked by
        // address; the credentialId path already 404'd above.
        return Response.json({ error: 'Unknown passkey address' }, { status: 404 });
      }

      return Response.json({ address, challenge });
    } catch (e) {
      console.error('[PASSKEY] Challenge error:', e);
      return Response.json({ error: 'Failed to issue challenge' }, { status: 500 });
    }
  }

  // POST /api/auth/passkey/login — verify a signed challenge and mint a session.
  // Body: { address, signature }  (signature is base64 of ed448.sign(challenge))
  // The challenge itself comes from KV (issued via /challenge) — never trusted
  // from the client. Single-use: consumed on this request whether or not
  // verification succeeds.
  if (pathname === "/api/auth/passkey/login" && request.method === "POST") {
    const limited = await rateGate(request, env, 'auth:passkey:login', 10);
    if (limited) return limited;
    try {
      const body = await request.json() as { address?: string; credentialId?: string; signature?: string };

      if (!body.signature) {
        return Response.json({ error: 'Missing signature' }, { status: 400 });
      }
      if (!body.address && !body.credentialId) {
        return Response.json({ error: 'Missing address or credentialId' }, { status: 400 });
      }

      const { PasskeyAuthService } = await import('../services/PasskeyAuthService');

      let address = body.address;
      if (!address && body.credentialId) {
        const resolved = await PasskeyAuthService.resolveAddressByCredentialId(env, body.credentialId);
        if (!resolved) {
          return Response.json({ error: 'Unknown credential' }, { status: 404 });
        }
        address = resolved;
      }

      const result = await PasskeyAuthService.login(env, address!, body.signature);

      if (!result) {
        // Generic 401 — do not leak which step failed (unknown address vs.
        // missing challenge vs. signature mismatch).
        return Response.json({ error: 'Authentication failed' }, { status: 401 });
      }

      // Look up stored profile from users table (seeded at registration)
      let fname = result.fname;
      let pfpUrl: string | null = null;
      let displayName = result.displayName;
      const usersRow = await env.DB.prepare(
        'SELECT username, display_name, pfp_url FROM users WHERE quil_address = ?'
      ).bind(result.address).first() as { username: string | null; display_name: string | null; pfp_url: string | null } | null;

      if (usersRow) {
        fname = usersRow.username || fname;
        pfpUrl = usersRow.pfp_url || null;
        displayName = usersRow.display_name || displayName;
      }

      // The person key (fid before the cutover, account id after); fid = the linked Farcaster fid.
      const accountId = await userKeyForPasskey(env, result.address).catch((err) => {
        console.warn('[PASSKEY] account resolution failed at login:', err);
        return undefined;
      });

      return Response.json({
        success: true,
        sessionToken: result.sessionToken,
        address: result.address,
        account_id: accountId ?? null,
        fid: result.fid,
        displayName,
        fname,
        pfpUrl,
      });
    } catch (e) {
      console.error('[PASSKEY] Login error:', e);
      return Response.json(
        { error: 'Failed to login with passkey' },
        { status: 500 }
      );
    }
  }

  // GET /api/auth/passkey/user - Get current passkey user info (requires auth)
  if (pathname === "/api/auth/passkey/user" && request.method === "GET") {
    try {
      const auth = await requireFlexibleAuth(request, env);
      if (!auth.authenticated || !auth.passkeyAddress) {
        return Response.json({ error: 'Not authenticated with passkey' }, { status: 401 });
      }

      const { PasskeyAuthService } = await import('../services/PasskeyAuthService');
      const user = await PasskeyAuthService.getUser(env, auth.passkeyAddress);

      if (!user) {
        return Response.json({ error: 'User not found' }, { status: 404 });
      }

      return Response.json(user);
    } catch (e) {
      console.error('[PASSKEY] Get user error:', e);
      return Response.json({ error: 'Failed to get user' }, { status: 500 });
    }
  }

  return null;
}
