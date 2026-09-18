/**
 * Anon Attribution Service - Using D1
 *
 * Stores attribution records in D1 anon_attributions table.
 * Links anonymous content to real authors while maintaining privacy.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

/**
 * Parameters for creating an attribution record
 */
export interface AttributionParams {
  public_id: string;              // Query or answer ID (publicly visible)
  author_id: number;              // Real user ID (stored in D1)
  type: 'question' | 'answer' | 'direct_query';
  created_at?: string;            // ISO 8601; defaults to now()
}

/**
 * HiddenLink record structure
 * Links anonymous content to real author
 */
export interface HiddenLink {
  _id: string;
  public_id: string;
  author_id: number;
  type: 'question' | 'answer' | 'direct_query';
  created_at?: string;
}

/**
 * Service for managing anonymous content attribution.
 *
 * When users create anonymous queries or answers, we store an attribution record
 * that links the content to the real author. This is kept private.
 *
 * This enables:
 * - Users to claim viral anonymous content later
 * - Governance/moderation to enforce accountability without compromising everyday anonymity
 * - Appeals process where users can prove ownership
 *
 * Note on the privacy model: `author_id` is stored in plaintext, so this table is
 * a complete answer→author map. Anonymity here is access control enforced at read
 * time, not cryptography — whoever operates the database can attribute any
 * anonymous row. Every read path must therefore resolve ownership without ever
 * returning the linkage to a caller who is not the author.
 */
export class AnonAttributionService {
  /**
   * Create attribution record linking anonymous content to real author
   *
   * @param env - Cloudflare environment with D1 database
   * @param params - Attribution parameters (public_id, author_id, type)
   * @returns Attribution ID and success status
   *
   * @example
   * await AnonAttributionService.createAttribution(env, {
   *   public_id: 'query-uuid-123',
   *   author_id: 789,
   *   type: 'question'
   * });
   */
  static async createAttribution(
    env: Env,
    params: AttributionParams
  ): Promise<{ success: boolean; attribution_id: string }> {
    try {
      const id = crypto.randomUUID();
      const createdAt = params.created_at ?? new Date().toISOString();

      await env.DB.prepare(
        `INSERT INTO anon_attributions (id, public_id, author_id, type, created_at) VALUES (?, ?, ?, ?, ?)`
      ).bind(id, params.public_id, params.author_id, params.type, createdAt).run();

      console.log(`Created attribution for ${params.type} ${params.public_id}`);

      return {
        success: true,
        attribution_id: id,
      };
    } catch (error) {
      console.error('Error creating attribution:', error);
      throw new Error(`Failed to create attribution record: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Get attribution record for anonymous content
   *
   * Used for:
   * - Claiming content (user proves ownership)
   * - Governance actions (moderation)
   * - User viewing their own anonymous posts
   *
   * Callers are responsible for never surfacing `author_id` to anyone but the
   * author themselves — use `getUserAnonymousContent` for the ownership test.
   *
   * @param env - Cloudflare environment
   * @param public_id - The query or answer ID
   * @returns HiddenLink record or null if not found
   *
   * @example
   * const attribution = await AnonAttributionService.getAttribution(env, 'answer-uuid-456');
   * if (attribution) {
   *   console.log('Author ID:', attribution.author_id);
   * }
   */
  static async getAttribution(
    env: Env,
    public_id: string
  ): Promise<HiddenLink | null> {
    try {
      const row = await env.DB.prepare(
        `SELECT id as _id, public_id, author_id, type, created_at FROM anon_attributions WHERE public_id = ?`
      ).bind(public_id).first();

      if (!row) {
        return null;
      }

      return row as HiddenLink;
    } catch (error) {
      console.error('Error fetching attribution:', error);
      return null;
    }
  }

  /**
   * List all anonymous content by a user
   *
   * Used for:
   * - "My Anonymous Posts" page
   * - Ownership checks before a reveal / re-scope
   * - Marking the requester's own anon rows (`is_own_anon`) on a read
   *
   * Uses the D1 index on (author_id, type) for efficient lookups.
   *
   * @param env - Cloudflare environment
   * @param author_id - The user's ID
   * @returns Array of HiddenLink records
   *
   * @example
   * const userAnon = await AnonAttributionService.getUserAnonymousContent(env, 789);
   * console.log(`User has ${userAnon.length} anonymous posts`);
   */
  static async getUserAnonymousContent(
    env: Env,
    author_id: number
  ): Promise<HiddenLink[]> {
    try {
      // Query D1 anon_attributions by author_id
      const result = await env.DB.prepare(
        `SELECT id as _id, public_id, author_id, type, created_at 
         FROM anon_attributions WHERE author_id = ?`
      ).bind(author_id).all();

      return (result?.results as HiddenLink[]) || [];
    } catch (error) {
      console.error('Error fetching user anonymous content:', error);
      return [];
    }
  }
}
