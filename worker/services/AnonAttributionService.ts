/**
 * Anon Attribution Service - Using Nillion via proxy
 * 
 * Stores attribution records in Nillion with encrypted author_id.
 * Links anonymous content to real authors while maintaining privacy.
 */

import { NillionProxyClient } from './NillionProxyClient';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

/**
 * Parameters for creating an attribution record
 */
export interface AttributionParams {
  public_id: string;              // Query or answer ID (publicly visible)
  author_id: number;              // Real user ID (will be encrypted when Nillion is re-enabled)
  type: 'question' | 'answer' | 'direct_query';
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
 */
export class AnonAttributionService {
  /**
   * Create attribution record linking anonymous content to real author
   * 
   * @param env - Cloudflare environment with Nillion proxy access
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
      const proxyClient = new NillionProxyClient(env);

      const result = await proxyClient.createAttribution({
        public_id: params.public_id,
        author_id: params.author_id,
        type: params.type,
      });

      console.log(`Created attribution for ${params.type} ${params.public_id}`);

      return {
        success: result.success,
        attribution_id: result.attribution_id,
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
      const proxyClient = new NillionProxyClient(env);
      const nillionAttr = await proxyClient.getAttribution(public_id);

      if (!nillionAttr) {
        return null;
      }

      // Decrypt %share field
      const authorId = typeof nillionAttr.author_id === 'object' && '%share' in nillionAttr.author_id
        ? nillionAttr.author_id['%share']
        : nillionAttr.author_id;

      return {
        _id: nillionAttr._id,
        public_id: nillionAttr.public_id,
        author_id: authorId,
        type: nillionAttr.type as 'question' | 'answer' | 'direct_query',
      };
    } catch (error) {
      console.error('Error fetching attribution:', error);
      return null;
    }
  }

  /**
   * Verify that a user owns a piece of anonymous content
   * 
   * Used when user wants to claim content or prove ownership for appeals.
   * 
   * @param env - Cloudflare environment
   * @param public_id - The query or answer ID
   * @param claimed_author_id - The user ID claiming ownership
   * @returns True if user owns the content
   * 
   * @example
   * const isOwner = await AnonAttributionService.verifyOwnership(
   *   env,
   *   'query-uuid-123',
   *   789
   * );
   * if (isOwner) {
   *   // User can claim or reveal this content
   * }
   */
  static async verifyOwnership(
    env: Env,
    public_id: string,
    claimed_author_id: number
  ): Promise<boolean> {
    try {
      const attribution = await this.getAttribution(env, public_id);
      
      if (!attribution) {
        console.log(`No attribution found for ${public_id}`);
        return false;
      }

      return attribution.author_id === claimed_author_id;
    } catch (error) {
      console.error('Error verifying ownership:', error);
      return false;
    }
  }

  /**
   * List all anonymous content by a user
   * 
   * Used for:
   * - "My Anonymous Posts" page
   * - Bulk claim/reveal operations
   * - User reviewing their anonymous content history
   * 
   * NOTE: This requires querying Nillion by author_id which may not be
   * efficient. For now, we keep a D1 index for this purpose.
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
      // For efficiency, keep a D1 index of public_id -> exists mapping
      // Then fetch full records from Nillion as needed
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

  /**
   * Get all attributions (admin/debugging use)
   * 
   * Retrieves all attribution records. Should be restricted to admin users.
   * Used for:
   * - Moderation dashboards
   * - Debugging attribution issues
   * - Analytics on anonymous content
   * 
   * NOTE: This still uses D1 for efficiency. Full records can be fetched from
   * Nillion as needed.
   * 
   * @param env - Cloudflare environment
   * @returns Array of all HiddenLink records
   */
  static async getAllAttributions(env: Env): Promise<HiddenLink[]> {
    try {
      const result = await env.DB.prepare(
        `SELECT id as _id, public_id, author_id, type, created_at 
         FROM anon_attributions ORDER BY created_at DESC`
      ).all();

      return (result?.results as HiddenLink[]) || [];
    } catch (error) {
      console.error('Error fetching all attributions:', error);
      return [];
    }
  }
}
