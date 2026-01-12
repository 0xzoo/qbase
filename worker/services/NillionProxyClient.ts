/**
 * Nillion Proxy Client
 * 
 * Communicates with the Nillion proxy service running on Fly.io.
 * Handles all encrypted answer storage and retrieval through the proxy.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

/**
 * Request to store an answer in Nillion
 */
export interface StoreAnswerRequest {
  q_id: string;
  user_id: number;
  value: string;
  answer_type_id: string;
  audience: 'Private' | 'Anon' | 'Allowlist';
  primary_type: 'identity' | 'recurring' | 'prospective' | 'knowledge' | 'predictive';
  allowlist_id?: string;
  allowlist?: number[];
}

/**
 * Response from storing an answer
 */
export interface StoreAnswerResponse {
  success: boolean;
  answer_id: string;
  nillion_result?: unknown;
}

/**
 * Request to store attribution in Nillion
 */
export interface AttributionRequest {
  public_id: string;
  author_id: number;
  type: 'question' | 'answer' | 'direct_query';
}

/**
 * Response from storing attribution
 */
export interface AttributionResponse {
  success: boolean;
  attribution_id: string;
}

/**
 * Answer result from Nillion
 */
export interface NillionAnswer {
  _id: string;
  q_id: string;
  user_id: number | { '%allot': number };
  value: string | { '%allot': string };
  answer_type_id: string;
  audience: string;
  created_at: string;
  primary_type: string;
  allowlist_id?: string;
  allowlist?: string[];
  q_index?: number;
}

/**
 * Attribution result from Nillion
 */
export interface NillionAttribution {
  _id: string;
  public_id: string;
  author_id: number | { '%share': number };
  type: string;
}

/**
 * Client for communicating with the Nillion proxy service
 */
export class NillionProxyClient {
  private baseUrl: string;
  private secret: string;

  constructor(env: Env) {
    this.baseUrl = env.NILLION_PROXY_URL;
    this.secret = env.NILLION_PROXY_SECRET;

    if (!this.baseUrl || !this.secret) {
      throw new Error('NILLION_PROXY_URL and NILLION_PROXY_SECRET must be configured');
    }
  }

  /**
   * Store an answer in Nillion
   */
  async storeAnswer(data: StoreAnswerRequest): Promise<StoreAnswerResponse> {
    try {
      const response = await fetch(`${this.baseUrl}/v1/answers`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Proxy-Secret': this.secret,
        },
        body: JSON.stringify(data),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Proxy error: ${response.status} ${error}`);
      }

      return await response.json() as StoreAnswerResponse;
    } catch (error) {
      console.error('Error storing answer via proxy:', error);
      throw error;
    }
  }

  /**
   * List answers for a query
   */
  async listAnswers(
    q_id: string,
    user_id?: number,
    audience?: string
  ): Promise<{ results: NillionAnswer[]; total: number }> {
    try {
      const params = new URLSearchParams({ q_id });
      if (user_id) params.append('user_id', user_id.toString());
      if (audience) params.append('audience', audience);

      const response = await fetch(`${this.baseUrl}/v1/answers?${params}`, {
        method: 'GET',
        headers: {
          'X-Proxy-Secret': this.secret,
        },
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Proxy error: ${response.status} ${error}`);
      }

      return await response.json() as { results: NillionAnswer[]; total: number };
    } catch (error) {
      console.error('Error listing answers via proxy:', error);
      throw error;
    }
  }

  /**
   * Get a single answer by ID
   */
  async getAnswer(answerId: string): Promise<NillionAnswer | null> {
    try {
      const response = await fetch(`${this.baseUrl}/v1/answers/${answerId}`, {
        method: 'GET',
        headers: {
          'X-Proxy-Secret': this.secret,
        },
      });

      if (response.status === 404) {
        return null;
      }

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Proxy error: ${response.status} ${error}`);
      }

      return await response.json() as NillionAnswer;
    } catch (error) {
      console.error('Error getting answer via proxy:', error);
      throw error;
    }
  }

  /**
   * Create an attribution record in Nillion
   */
  async createAttribution(data: AttributionRequest): Promise<AttributionResponse> {
    try {
      const response = await fetch(`${this.baseUrl}/v1/attributions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Proxy-Secret': this.secret,
        },
        body: JSON.stringify(data),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Proxy error: ${response.status} ${error}`);
      }

      return await response.json() as AttributionResponse;
    } catch (error) {
      console.error('Error creating attribution via proxy:', error);
      throw error;
    }
  }

  /**
   * Get an attribution record by public ID
   */
  async getAttribution(publicId: string): Promise<NillionAttribution | null> {
    try {
      const response = await fetch(`${this.baseUrl}/v1/attributions/${publicId}`, {
        method: 'GET',
        headers: {
          'X-Proxy-Secret': this.secret,
        },
      });

      if (response.status === 404) {
        return null;
      }

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Proxy error: ${response.status} ${error}`);
      }

      return await response.json() as NillionAttribution;
    } catch (error) {
      console.error('Error getting attribution via proxy:', error);
      throw error;
    }
  }

  /**
   * List attributions by author_id and optional type
   * Used to find user's own anonymous content
   */
  async listAttributions(
    authorId: number,
    type?: 'question' | 'answer' | 'direct_query'
  ): Promise<{ results: NillionAttribution[]; total: number }> {
    try {
      const params = new URLSearchParams({ author_id: authorId.toString() });
      if (type) params.append('type', type);

      const response = await fetch(`${this.baseUrl}/v1/attributions?${params}`, {
        method: 'GET',
        headers: {
          'X-Proxy-Secret': this.secret,
        },
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Proxy error: ${response.status} ${error}`);
      }

      return await response.json() as { results: NillionAttribution[]; total: number };
    } catch (error) {
      console.error('Error listing attributions via proxy:', error);
      throw error;
    }
  }

  /**
   * Check if proxy is available
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        method: 'GET',
      });

      return response.ok;
    } catch {
      return false;
    }
  }
}

