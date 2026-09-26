import { sdk } from '@farcaster/miniapp-sdk';

/**
 * API Client for making authenticated requests
 * Uses Quick Auth for MiniApp context, session tokens for web context
 */
export class ApiClient {
  private baseUrl: string;
  private getAuthTokens?: () => { sessionToken?: string; quickAuthToken?: string } | null;
  private onUnauthorized?: () => void;

  constructor(baseUrl: string = '') {
    this.baseUrl = baseUrl;
  }

  /**
   * Set callback to get auth tokens (session or JWT)
   */
  setSIWFCredentialsGetter(getter: () => { sessionToken?: string; quickAuthToken?: string } | null) {
    this.getAuthTokens = getter;
  }

  /**
   * Set callback for when a 401 Unauthorized response is received
   * Used to trigger logout when session expires
   */
  setOnUnauthorized(callback: () => void) {
    this.onUnauthorized = callback;
  }

  /**
   * Make an authenticated request
   * - MiniApp: Uses Quick Auth JWT token
   * - Web: Uses session token
   * - Automatically handles 401 responses by triggering logout
   */
  async authenticatedFetch(endpoint: string, options: RequestInit = {}): Promise<Response> {
    const isMiniApp = await sdk.isInMiniApp();

    let response: Response;

    if (isMiniApp) {
      // Use Quick Auth fetch which automatically adds the JWT token
      response = await sdk.quickAuth.fetch(`${this.baseUrl}${endpoint}`, options);
    } else {
      // Web context: Add session token if available
      const tokens = this.getAuthTokens?.();
      if (tokens?.sessionToken) {
        const headers = new Headers(options.headers);
        headers.set('Authorization', `Bearer ${tokens.sessionToken}`);
        
        response = await fetch(`${this.baseUrl}${endpoint}`, {
          ...options,
          headers,
        });
      } else {
        // No token available - request will likely fail auth
        console.warn('[API] No session token available for authenticated request');
        response = await fetch(`${this.baseUrl}${endpoint}`, options);
      }
    }

    // Handle 401 Unauthorized - session has expired
    if (response.status === 401 && this.onUnauthorized) {
      console.warn('[API] Received 401 Unauthorized - session expired, triggering logout');
      this.onUnauthorized();
    }

    return response;
  }

  /**
   * POST request helper
   */
  async post(endpoint: string, data: unknown): Promise<Response> {
    return this.authenticatedFetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    });
  }

  /**
   * PUT request helper
   */
  async put(endpoint: string, data: unknown): Promise<Response> {
    return this.authenticatedFetch(endpoint, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    });
  }

  /**
   * GET request helper
   */
  async get(endpoint: string): Promise<Response> {
    return this.authenticatedFetch(endpoint, {
      method: 'GET',
    });
  }

  /**
   * DELETE request helper
   */
  async delete(endpoint: string): Promise<Response> {
    return this.authenticatedFetch(endpoint, {
      method: 'DELETE',
    });
  }
}

// Export a singleton instance
export const apiClient = new ApiClient();
