import { AuthService } from '../services/AuthService';
import { RateLimitService } from '../services/RateLimitService';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

export interface AuthResult {
  authenticated: boolean;
  fid?: number;
  error?: string;
}

export interface AuthRateLimitResult {
  auth: AuthResult;
  rateLimited: boolean;
}

/**
 * Flexible authentication middleware
 * 
 * Supports both JWT (MiniApp) and SIWF (Web) authentication
 * - Tries JWT first (Authorization: Bearer token)
 * - Falls back to SIWF (X-FC-Message, X-FC-Signature, X-FC-Nonce headers)
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
  const authService = AuthService.fromEnv(env, request.url);
  
  // Try JWT auth first
  const authHeader = request.headers.get('Authorization');
  if (authHeader) {
    const jwtResult = await authService.verifyAuthHeader(authHeader);
    if (jwtResult.valid) {
      return {
        authenticated: true,
        fid: jwtResult.fid
      };
    }
  }
  
  // Fall back to SIWF authentication
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
