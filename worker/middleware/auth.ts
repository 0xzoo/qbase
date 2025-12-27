import { AuthService } from '../services/AuthService';
import { RateLimitService } from '../services/RateLimitService';

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
 * Authentication middleware helper
 * 
 * Verifies Quick Auth JWT token from Authorization header
 * 
 * @param request - The incoming request
 * @param env - Cloudflare Worker environment bindings
 * @returns AuthResult with authenticated status and user FID
 * 
 * @example
 * const auth = await requireAuth(request, env);
 * if (!auth.authenticated) {
 *   return new Response(auth.error || "Unauthorized", { status: 401 });
 * }
 * const userFid = auth.fid; // Use the verified FID
 */
export async function requireAuth(request: Request, env: any): Promise<AuthResult> {
  // Pass request URL to handle preview URLs dynamically
  const authService = AuthService.fromEnv(env, request.url);
  const result = await authService.verifyAuthHeader(
    request.headers.get('Authorization')
  );

  return {
    authenticated: result.valid,
    fid: result.fid,
    error: result.error
  };
}

/**
 * Combined authentication and rate limiting middleware
 * 
 * Checks rate limit first (to prevent abuse), then verifies authentication
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
  env: any,
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

  // Then check authentication
  const auth = await requireAuth(request, env);
  return { auth, rateLimited: false };
}
