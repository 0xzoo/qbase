import { sdk } from '@farcaster/miniapp-sdk';

/**
 * API Client for making authenticated requests
 * Uses Quick Auth for MiniApp context
 */
export class ApiClient {
  private baseUrl: string;

  constructor(baseUrl: string = '') {
    this.baseUrl = baseUrl;
  }

  /**
   * Make an authenticated request using Quick Auth fetch
   * This automatically includes the Bearer token in the Authorization header
   */
  async authenticatedFetch(endpoint: string, options: RequestInit = {}): Promise<Response> {
    const isMiniApp = await sdk.isInMiniApp();

    if (isMiniApp) {
      // Use Quick Auth fetch which automatically adds the token
      return sdk.quickAuth.fetch(`${this.baseUrl}${endpoint}`, options);
    } else {
      // For web context, we need a different approach
      // For now, just make a regular request
      return fetch(`${this.baseUrl}${endpoint}`, options);
    }
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
   * GET request helper
   */
  async get(endpoint: string): Promise<Response> {
    return this.authenticatedFetch(endpoint, {
      method: 'GET',
    });
  }
}

// Export a singleton instance
export const apiClient = new ApiClient();
