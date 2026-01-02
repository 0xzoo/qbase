// Authentication packages:
// - @farcaster/quick-auth: Verifies JWT tokens from MiniApp Quick Auth
// - @farcaster/auth-client: Verifies SIWF signatures from web Auth Kit
import { createClient, Errors } from '@farcaster/quick-auth';
import { createAppClient, viemConnector } from '@farcaster/auth-client';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

export class AuthService {
  private client: ReturnType<typeof createClient>;
  private appClient: ReturnType<typeof createAppClient>;
  private hostname: string;

  constructor(hostname: string) {
    this.client = createClient();
    this.appClient = createAppClient({
      relay: 'https://relay.farcaster.xyz',
      ethereum: viemConnector({
        rpcUrl: 'https://optimism.drpc.org',
      }),
    });
    this.hostname = hostname;
  }

  static fromEnv(env: Env, requestUrl?: string): AuthService {
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
      } catch {
        // Fall back to configured hostname
      }
    }
    
    return new AuthService(hostname);
  }

  /**
   * Verify a Sign In With Farcaster (SIWF) message and signature
   * @param message The SIWF message signed by the user
   * @param signature The signature from the user
   * @param nonce The nonce that was used in the message
   * @returns Object with success flag, fid, and optional error message
   */
  async verifySIWFMessage(params: {
    message: string;
    signature: string;
    nonce: string;
  }): Promise<{ success: boolean; fid?: number; error?: string }> {
    try {
      // Parse the message to extract the domain that was actually signed
      const messageLines = params.message.split('\n');
      const uriLine = messageLines.find(line => line.startsWith('URI:'));
      const domainLine = messageLines.find(line => line.includes('wants you to sign in with your Ethereum account'));
      
      // Extract domain from the message
      let extractedDomain = this.hostname; // fallback
      
      if (domainLine) {
        const match = domainLine.match(/^(https?:\/\/[^\s]+)/);
        if (match) {
          const url = new URL(match[1]);
          extractedDomain = url.host;
        }
      }
      
      if (uriLine) {
        const match = uriLine.match(/^URI:\s*(https?:\/\/[^\s]+)/);
        if (match) {
          const url = new URL(match[1]);
          extractedDomain = url.host;
        }
      }
      
      console.log(`[AUTH] Verifying SIWF signature with domain: ${extractedDomain}`);

      // Verify the signature using @farcaster/auth-client
      // This is the real security - cryptographic verification via RPC
      const result = await this.appClient.verifySignInMessage({
        nonce: params.nonce,
        domain: extractedDomain,
        message: params.message,
        signature: params.signature as `0x${string}`,
        acceptAuthAddress: true,
      });

      console.log('[AUTH] Verification result:', JSON.stringify({
        success: result.success,
        fid: result.fid,
        error: (result as any).error,
        message: (result as any).message,
      }));

      if (!result.success) {
        console.error('[AUTH] Signature verification failed - details:', result);
        return { success: false, error: 'Invalid signature' };
      }

      console.log(`[AUTH] ✅ Successfully verified SIWF for FID ${result.fid}`);
      return {
        success: true,
        fid: result.fid,
      };
    } catch (e) {
      console.error('[AUTH] Error verifying SIWF message:', e);
      return { success: false, error: 'Verification failed' };
    }
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
        } catch {
          // Fall through to original error handling
        }
      }
      if (e instanceof Errors.InvalidTokenError) {
        // Don't log JWS errors - they're expected for session tokens
        // The middleware will try session token verification next
        return { valid: false, error: 'Invalid token' };
      }

      // Only log unexpected errors (not JWS errors which are normal for web users)
      const errorMessage = e instanceof Error ? e.message : String(e);
      if (!errorMessage.includes('JWS') && !errorMessage.includes('JWE')) {
        console.error('Error verifying Quick Auth token:', e);
      }
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
