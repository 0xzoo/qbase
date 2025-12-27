/// <reference path="../../worker-configuration.d.ts" />
import { createClient, Errors } from '@farcaster/quick-auth';
export class AuthService {
  private kv: KVNamespace;
  private client: ReturnType<typeof createClient>;
  private hostname: string;

  constructor(kv: KVNamespace, hostname: string) {
    this.kv = kv;
    this.client = createClient();
    this.hostname = hostname;
  }

  static fromEnv(env: any, requestUrl?: string): AuthService {
    // Prefer actual hostname from request, fall back to config
    let hostname = env.HOSTNAME || 'localhost:5173';
    
    // If request URL provided, use it for preview URLs
    if (requestUrl) {
      try {
        const url = new URL(requestUrl);
        // Use request hostname for workers.dev domains (handles preview URLs)
        if (url.hostname.includes('.workers.dev')) {
          hostname = url.hostname;
        }
      } catch (e) {
        // Fall back to configured hostname
      }
    }
    
    return new AuthService(env.KV_USER_PROFILES, hostname);
  }

  async generateNonce(): Promise<string> {
    const nonce = crypto.randomUUID();
    // Store nonce with 5 minute expiration
    await this.kv.put(`nonce:${nonce}`, 'true', { expirationTtl: 300 });
    return nonce;
  }

  async verifyNonce(nonce: string): Promise<boolean> {
    const exists = await this.kv.get(`nonce:${nonce}`);
    if (exists) {
      // Invalidate nonce after use to prevent replay attacks
      await this.kv.delete(`nonce:${nonce}`);
      return true;
    }
    return false;
  }

  /**
   * Verify a Quick Auth JWT token
   * @param token The JWT token from the Authorization header
   * @returns Object with valid flag and fid if valid
   */
  async verifyQuickAuthToken(token: string): Promise<{ valid: boolean; fid?: number; error?: string }> {
    try {
      const payload = await this.client.verifyJwt({
        token,
        domain: this.hostname,
      });

      // The payload.sub contains the FID
      return { valid: true, fid: payload.sub };
    } catch (e) {
      // For preview URLs, try wildcard matching on workers.dev domains
      if (this.hostname.includes('.workers.dev') && e instanceof Error && e.message?.includes('domain')) {
        try {
          // Extract base domain pattern (e.g., "qbase-v2.z00.workers.dev" from "abc123.qbase-v2-dev.z00.workers.dev")
          const baseDomain = this.hostname.split('.').slice(-3).join('.');
          const payload = await this.client.verifyJwt({
            token,
            domain: baseDomain,
          });
          return { valid: true, fid: payload.sub };
        } catch (fallbackError) {
          // Fall through to original error handling
        }
      }
      if (e instanceof Errors.InvalidTokenError) {
        console.info('Invalid Quick Auth token:', e.message);
        return { valid: false, error: 'Invalid token' };
      }

      console.error('Error verifying Quick Auth token:', e);
      return { valid: false, error: 'Token verification failed' };
    }
  }

  /**
   * Middleware helper to extract and verify Bearer token from Authorization header
   */
  async verifyAuthHeader(authHeader: string | null): Promise<{ valid: boolean; fid?: number; error?: string }> {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return { valid: false, error: 'Missing or invalid Authorization header' };
    }

    const token = authHeader.split(' ')[1];
    return this.verifyQuickAuthToken(token);
  }
}
