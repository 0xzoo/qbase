import { AuthService } from '../services/AuthService';
import { RateLimitService } from '../services/RateLimitService';
import {
  isRewritten, isAccountId, farcasterFidOf, userKeyForFid, userKeyForPasskey,
} from '../services/accounts/AccountService';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

export interface AuthResult {
  authenticated: boolean;
  /**
   * The value to read and write in person-key columns (Answers.user_id,
   * quiz_completions.user_id, Users.fid, …): the fid before the account
   * cutover, the account id after (docs/specs/account-root.md). Use this for
   * anything that is "this person's row"; use `fid` only for Farcaster
   * operations (signers, casts, hub/Neynar lookups).
   */
  userKey?: number;
  /** The account id, once the cutover has run. */
  accountId?: number;
  /** How an account session was opened ('ethereum' | 'world'); absent for Farcaster / passkey. */
  via?: string;
  fid?: number;              // the linked Farcaster fid, if any (miniapp, FC port)
  quilAddress?: string;      // Passkey user identity (Quilibrium address)
  passkeyAddress?: string;   // Alias for quilAddress (backwards compat)
  user?: {                   // Legacy field - maps to { fid, quilAddress }
    fid?: number;
    quilAddress?: string;
    username?: string;
  };
  error?: string;
}

export interface AuthRateLimitResult {
  auth: AuthResult;
  rateLimited: boolean;
}

/**
 * Flexible authentication middleware
 * 
 * Supports multiple authentication methods:
 * 1. JWT (MiniApp) - Authorization: Bearer <jwt>
 * 2. Session token (Web) - Authorization: Bearer <session>
 * 3. SIWF (Web, single-use) - X-FC-Message, X-FC-Signature, X-FC-Nonce headers
 * 
 * @param request - The incoming request
 * @param env - Cloudflare Worker environment bindings
 * @returns AuthResult with authenticated status and user FID
 * 
 * @example
 * const auth = await requireFlexibleAuth(request, env);
 * if (!auth.authenticated) {
 *   return new Response(auth.error || "Unauthorized", { status: 401 });
 * }
 * const userFid = auth.fid; // Use the verified FID
 */
export async function requireFlexibleAuth(request: Request, env: Env): Promise<AuthResult> {
  return withAccount(env, await authenticateCredentials(request, env));
}

/**
 * Attach `userKey` / `accountId` / `fid` to a verified credential. Before the
 * cutover this is the identity function plus `userKey = fid` (passkeys: the
 * key their Users row carries). Fails closed: a resolution error is an
 * unauthenticated result, never a guessed key.
 */
async function withAccount(env: Env, r: AuthResult): Promise<AuthResult> {
  if (!r.authenticated) return r;
  try {
    if (r.accountId !== undefined) {
      if (!(await isRewritten(env))) return { authenticated: false, error: 'accounts_not_ready' };
      return { ...r, userKey: r.accountId, fid: await farcasterFidOf(env, r.accountId) };
    }
    const address = r.passkeyAddress || r.quilAddress;
    if (address) {
      const key = await userKeyForPasskey(env, address);
      if (key === undefined) return r;
      const accountId = isAccountId(key) ? key : undefined;
      const fid = r.fid ?? (accountId !== undefined ? await farcasterFidOf(env, accountId) : undefined);
      return { ...r, userKey: key, accountId, fid };
    }
    if (r.fid) {
      const key = await userKeyForFid(env, r.fid);
      return { ...r, userKey: key, accountId: isAccountId(key) ? key : undefined };
    }
    return r;
  } catch (error) {
    console.error('[Auth] account resolution failed:', error);
    return { authenticated: false, error: 'account_resolution_failed' };
  }
}

async function authenticateCredentials(request: Request, env: Env): Promise<AuthResult> {
  const authService = AuthService.fromEnv(env, request.url);
  
  // Try Bearer token (JWT or session token)
  const authHeader = request.headers.get('Authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    
    // Try JWT first (Quick Auth)
    const jwtResult = await authService.verifyQuickAuthToken(token);
    if (jwtResult.valid) {
      return {
        authenticated: true,
        fid: jwtResult.fid
      };
    }
    
    // Try session token (only if token is short enough for KV key limit)
    // KV keys have 512 byte limit, session prefix is 8 bytes, leave margin
    if (token.length <= 450) {
      try {
        const sessionData = await env.KV_USER_PROFILES.get(`session:${token}`);
        if (sessionData) {
          const session = JSON.parse(sessionData) as { fid?: number; passkeyAddress?: string; quilAddress?: string; accountId?: number; via?: string; expiresAt: number };
          if (session.expiresAt > Date.now()) {
            // Account session (Sign in with Ethereum / World ID): the account is the identity
            if (isAccountId(session.accountId)) {
              return { authenticated: true, accountId: session.accountId, via: session.via };
            }
            // Passkey session (may also have a linked fid)
            if (session.passkeyAddress || session.quilAddress) {
              return {
                authenticated: true,
                fid: session.fid || undefined,
                passkeyAddress: session.passkeyAddress,
                quilAddress: session.quilAddress || session.passkeyAddress
              };
            }
            // Farcaster session
            if (session.fid) {
              return {
                authenticated: true,
                fid: session.fid
              };
            }
          }
        }
      } catch (error) {
        // KV lookup failed (e.g., key too long) - continue to other auth methods
        console.warn('[Auth] Session lookup failed:', error);
      }
    }
  }
  
  // Fall back to SIWF authentication (single-use)
  const message = request.headers.get('X-FC-Message');
  const signature = request.headers.get('X-FC-Signature');
  const nonce = request.headers.get('X-FC-Nonce');
  
  if (message && signature && nonce) {
    const siwfResult = await authService.verifySIWFMessage({
      message,
      signature,
      nonce
    });
    
    if (siwfResult.success) {
      return {
        authenticated: true,
        fid: siwfResult.fid
      };
    }
    
    return {
      authenticated: false,
      error: siwfResult.error || 'SIWF verification failed'
    };
  }
  
  return {
    authenticated: false,
    error: 'No valid authentication credentials provided'
  };
}

/**
 * Combined authentication and rate limiting middleware
 * 
 * Checks rate limit first (to prevent abuse), then verifies authentication
 * Supports both JWT (MiniApp) and SIWF (Web) authentication
 * 
 * @param request - The incoming request
 * @param env - Cloudflare Worker environment bindings
 * @param limit - Maximum number of requests allowed
 * @param windowSeconds - Time window in seconds
 * @returns AuthRateLimitResult with both auth and rate limit status
 * 
 * @example
 * const { auth, rateLimited } = await requireAuthAndRateLimit(request, env, 10, 60);
 * if (rateLimited) return new Response("Too Many Requests", { status: 429 });
 * if (!auth.authenticated) return new Response("Unauthorized", { status: 401 });
 * const userFid = auth.fid;
 */
export async function requireAuthAndRateLimit(
  request: Request,
  env: Env,
  limit: number,
  windowSeconds: number
): Promise<AuthRateLimitResult> {
  // Check rate limit first (cheaper operation, prevents auth check spam)
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const rateLimitService = RateLimitService.fromEnv(env);
  const allowed = await rateLimitService.checkLimit(ip, limit, windowSeconds);

  if (!allowed) {
    return {
      auth: { authenticated: false, error: 'Rate limit exceeded' },
      rateLimited: true
    };
  }

  // Then check authentication (flexible: JWT or SIWF)
  const auth = await requireFlexibleAuth(request, env);
  return { auth, rateLimited: false };
}

/**
 * Optional authentication check - returns FID if authenticated, undefined if not
 * Useful for endpoints that behave differently for authenticated users but don't require auth
 * 
 * @param request - The incoming request
 * @param env - Cloudflare Worker environment bindings
 * @returns FID if authenticated, undefined otherwise
 */
export async function getOptionalAuth(request: Request, env: Env): Promise<number | undefined> {
  const auth = await requireFlexibleAuth(request, env);
  return auth.authenticated ? auth.fid : undefined;
}

/**
 * Optional authentication, returning the person key (see AuthResult.userKey):
 * for endpoints that read or mark "my rows" without requiring sign-in.
 */
export async function getOptionalUserKey(request: Request, env: Env): Promise<number | undefined> {
  const auth = await requireFlexibleAuth(request, env);
  return auth.authenticated ? auth.userKey : undefined;
}
