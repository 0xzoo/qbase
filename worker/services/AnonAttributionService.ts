import { getNillionClient } from '../../src/lib/nillion/client';
import { SecretVaultBuilderClient } from '@nillion/secretvaults';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

/**
 * Parameters for creating an attribution record
 */
export interface AttributionParams {
  public_id: string;              // Query or answer ID (publicly visible)
  author_id: number;              // Real user ID or FID (will be encrypted)
  type: 'question' | 'answer' | 'direct_query';
}

/**
 * HiddenLink record structure
 * Links anonymous content to real author via encrypted attribution
 */
export interface HiddenLink {
  _id: string;
  public_id: string;
  author_id: { '%share': string } | number;  // Encrypted in storage, decrypted when retrieved with permissions
  type: 'question' | 'answer' | 'direct_query';
}

/**
 * Service for managing anonymous content attribution using Nillion SecretVault.
 * 
 * When users create anonymous queries or answers, we store a HiddenLink record
 * that encrypts the real author's identity while making the content publicly visible.
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
   * @param env - Cloudflare environment with Nillion configuration
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
      const client = await getNillionClient(env);
      const schemaId = env.NILLION_ANON_QUERY_ATTRIBUTION_SCHEMA_ID;

      if (!schemaId) {
        throw new Error('NILLION_ANON_QUERY_ATTRIBUTION_SCHEMA_ID not configured');
      }

      // Create attribution data
      // The '%share' wrapper tells Nillion to encrypt this field
      const attributionData: Record<string, unknown> = {
        _id: crypto.randomUUID(),
        public_id: params.public_id,
        author_id: { '%share': params.author_id },  // Nillion will encrypt this
        type: params.type,
      };

      // Store in Nillion using the anon_query_attribution collection
      const result = await client.createStandardData({
        collection: schemaId,
        data: [attributionData],
      });

      console.log(`Created attribution for ${params.type} ${params.public_id}`);

      return {
        success: true,
        attribution_id: attributionData._id as string,
      };
    } catch (error) {
      console.error('Error creating attribution:', error);
      throw new Error(`Failed to create attribution record: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Get attribution record for anonymous content
   * 
   * Requires proper Nillion permissions to decrypt the author_id field.
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
   *   console.log('Author ID:', attribution.author_id); // May still be encrypted
   * }
   */
  static async getAttribution(
    env: Env,
    public_id: string
  ): Promise<HiddenLink | null> {
    try {
      const client = await getNillionClient(env);
      const schemaId = env.NILLION_ANON_QUERY_ATTRIBUTION_SCHEMA_ID;

      if (!schemaId) {
        throw new Error('NILLION_ANON_QUERY_ATTRIBUTION_SCHEMA_ID not configured');
      }

      const result = await client.findData({
        collection: schemaId,
        filter: { public_id },
      });

      const data = result?.data as HiddenLink[] | undefined;
      return data && data.length > 0 ? data[0] : null;
    } catch (error) {
      console.error('Error fetching attribution:', error);
      return null;
    }
  }

  /**
   * Verify that a user owns a piece of anonymous content
   * 
   * Used when user wants to claim content or prove ownership for appeals.
   * Requires the attribution's author_id to be decrypted.
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

      // If author_id is still encrypted, we can't verify
      // The caller needs proper permissions to decrypt
      if (typeof attribution.author_id === 'object') {
        console.warn('Attribution still encrypted, cannot verify ownership');
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
   * Requires user's own query with permissions to decrypt their author_id.
   * Used for:
   * - "My Anonymous Posts" page
   * - Bulk claim/reveal operations
   * - User reviewing their anonymous content history
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
      const client = await getNillionClient(env);
      const schemaId = env.NILLION_ANON_QUERY_ATTRIBUTION_SCHEMA_ID;

      if (!schemaId) {
        throw new Error('NILLION_ANON_QUERY_ATTRIBUTION_SCHEMA_ID not configured');
      }

      // Note: This query will only work if the requesting user has permission
      // to decrypt the author_id field (i.e., they are the author)
      const result = await client.findData({
        collection: schemaId,
        filter: { author_id },
      });

      return (result?.data as HiddenLink[]) || [];
    } catch (error) {
      console.error('Error fetching user anonymous content:', error);
      return [];
    }
  }

  /**
   * Store attribution data directly (lower-level method)
   * 
   * Used internally or when you have a pre-configured attribution object.
   * Most code should use createAttribution() instead.
   * 
   * @param client - Nillion SecretVault client
   * @param attributionData - Pre-formatted attribution record
   * @param schemaId - Nillion collection schema ID
   * @returns Storage result
   */
  static async storeAttribution(
    client: SecretVaultBuilderClient,
    attributionData: Record<string, unknown>,
    schemaId: string
  ) {
    const result = await client.createStandardData({
      collection: schemaId,
      data: [attributionData],
    });
    return result;
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
   * @param env - Cloudflare environment
   * @returns Array of all HiddenLink records
   */
  static async getAllAttributions(env: Env): Promise<HiddenLink[]> {
    try {
      const client = await getNillionClient(env);
      const schemaId = env.NILLION_ANON_QUERY_ATTRIBUTION_SCHEMA_ID;

      if (!schemaId) {
        throw new Error('NILLION_ANON_QUERY_ATTRIBUTION_SCHEMA_ID not configured');
      }

      // Get all records (no filter)
      const result = await client.findData({
        collection: schemaId,
        filter: {},
      });

      return (result?.data as HiddenLink[]) || [];
    } catch (error) {
      console.error('Error fetching all attributions:', error);
      return [];
    }
  }
}

