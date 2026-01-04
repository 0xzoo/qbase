/**
 * Neynar Signer Service
 * 
 * Handles Neynar-managed signer creation and registration for Farcaster authentication.
 * This service enables users to authenticate with Farcaster and perform on-chain actions
 * (casts, likes, follows, etc.) through your app.
 * 
 * Flow:
 * 1. User signs SIWF message
 * 2. Check if user has existing approved signers
 * 3. If not, create new signer via Neynar
 * 4. Register signed key with Farcaster (requires app's EIP-712 signature)
 * 5. User approves signer via QR code or deep link
 * 6. Poll until signer is approved
 * 
 * Security: The app's seed phrase (QBASE_SEED_PHRASE) is used ONLY for signing
 * the registerSignedKey request. It never leaves the worker and is never exposed.
 */

import { NeynarAPIClient, Configuration } from '@neynar/nodejs-sdk';
import { mnemonicToAccount } from 'viem/accounts';
import { 
  SIGNED_KEY_REQUEST_VALIDATOR_EIP_712_DOMAIN, 
  SIGNED_KEY_REQUEST_TYPE,
  DEFAULT_SIGNED_KEY_DEADLINE 
} from '../../src/lib/farcaster-constants';

/**
 * Neynar Signer Service
 * Manages all signer-related operations
 */
export class NeynarSignerService {
  private client: NeynarAPIClient;

  constructor(apiKey: string) {
    this.client = new NeynarAPIClient(new Configuration({ apiKey }));
  }

  /**
   * Generate a nonce for Sign-In with Farcaster (SIWF)
   * This nonce ensures the signed message is unique and prevents replay attacks
   * 
   * Note: We generate our own nonce rather than fetching from Neynar.
   * A nonce is just a random string used once for authentication.
   */
  async fetchNonce(): Promise<{ nonce: string }> {
    try {
      // Generate a cryptographically secure random nonce
      // Using Web Crypto API (available in Cloudflare Workers)
      const array = new Uint8Array(32);
      crypto.getRandomValues(array);
      const nonce = Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
      
      return { nonce };
    } catch (error) {
      console.error('Error generating nonce:', error);
      throw new Error('Failed to generate authentication nonce');
    }
  }

  /**
   * Fetch existing signers for a user by FID
   * 
   * @param fid - The user's Farcaster ID
   * @returns Object containing signers array and user info
   * 
   * Note: In a full implementation, this would validate SIWF message/signature.
   * For now, we're using FID directly. The SIWF validation happens on the frontend
   * via Farcaster Auth Kit or SDK.
   */
  async fetchSigners(fid: number) {
    try {
      // Fetch user to get their signers
      // Note: The Neynar SDK doesn't have a direct "get all signers for FID" endpoint
      // In practice, signers are managed through the authentication flow
      // This method is a placeholder for when you need to refresh signer list
      
      return {
        signers: [], // Will be populated through the authentication flow
        fid: fid,
      };
    } catch (error) {
      console.error('Error fetching signers:', error);
      throw new Error('Failed to fetch signers');
    }
  }

  /**
   * Create a new signer
   * Returns signer_uuid and public_key that will be used in the next step
   */
  async createSigner(): Promise<{
    signer_uuid: string;
    public_key: string;
    status: string;
  }> {
    try {
      const signer = await this.client.createSigner();
      
      return {
        signer_uuid: signer.signer_uuid,
        public_key: signer.public_key,
        status: signer.status,
      };
    } catch (error) {
      console.error('Error creating signer:', error);
      throw new Error('Failed to create signer');
    }
  }

  /**
   * Register a signed key with the Farcaster protocol
   * This requires signing an EIP-712 message with the app's account
   * 
   * @param signerUuid - UUID of the signer from createSigner()
   * @param publicKey - Public key of the signer
   * @param seedPhrase - App's Farcaster account seed phrase (from env.QBASE_SEED_PHRASE)
   * @param sponsorSigner - Whether Neynar should sponsor the onchain costs
   * @returns Signer approval URL for user to scan/click
   */
  async registerSignedKey(
    signerUuid: string,
    publicKey: string,
    seedPhrase: string,
    sponsorSigner: boolean = false
  ): Promise<{
    signer_approval_url: string;
    signer_uuid: string;
    public_key: string;
  }> {
    try {
      // 1. Get the app's account from seed phrase
      const account = mnemonicToAccount(seedPhrase);
      
      // 2. Look up the app's FID using the custody address
      const { user } = await this.client.lookupUserByCustodyAddress({
        custodyAddress: account.address,
      });
      
      const appFid = user.fid;
      
      // 3. Generate deadline (24 hours from now)
      const deadline = Math.floor(Date.now() / 1000) + DEFAULT_SIGNED_KEY_DEADLINE;
      
      // 4. Sign the EIP-712 typed data
      const signature = await account.signTypedData({
        domain: SIGNED_KEY_REQUEST_VALIDATOR_EIP_712_DOMAIN,
        types: {
          SignedKeyRequest: SIGNED_KEY_REQUEST_TYPE,
        },
        primaryType: 'SignedKeyRequest',
        message: {
          requestFid: BigInt(appFid),
          key: publicKey as `0x${string}`,
          deadline: BigInt(deadline),
        },
      });
      
      // 5. Register the signed key with Neynar
      const registerConfig: {
        signerUuid: string;
        appFid: number;
        deadline: number;
        signature: string;
        sponsor?: { fid: number };
      } = {
        signerUuid: signerUuid,
        appFid: appFid,
        deadline: deadline,
        signature: signature,
      };
      
      // Add sponsorship if enabled
      if (sponsorSigner) {
        registerConfig.sponsor = { fid: appFid };
      }
      
      const result = await this.client.registerSignedKey(registerConfig);
      
      return {
        signer_approval_url: result.signer_approval_url || '',
        signer_uuid: signerUuid,
        public_key: publicKey,
      };
    } catch (error) {
      console.error('Error registering signed key:', error);
      throw new Error('Failed to register signed key');
    }
  }

  /**
   * Look up the status of a signer
   * Used for polling to check if user has approved the signer
   * 
   * @param signerUuid - UUID of the signer to check
   * @returns Signer status and details
   */
  async lookupSigner(signerUuid: string): Promise<{
    signer_uuid: string;
    public_key: string;
    status: 'pending_approval' | 'approved' | 'revoked';
    fid?: number;
  }> {
    try {
      const signer = await this.client.lookupSigner({
        signerUuid,
      });
      
      return {
        signer_uuid: signer.signer_uuid,
        public_key: signer.public_key,
        status: signer.status as 'pending_approval' | 'approved' | 'revoked',
        fid: signer.fid,
      };
    } catch (error) {
      console.error('Error looking up signer:', error);
      throw new Error('Failed to lookup signer status');
    }
  }

  /**
   * Publish a cast using an approved signer
   * This is an example of using a signer for Farcaster actions
   * 
   * @param signerUuid - UUID of an approved signer
   * @param text - Text content of the cast
   * @param embeds - Optional embeds (URLs, images, etc.)
   * @param parent - Optional parent cast hash (for replies)
   * @param parentAuthorFid - Optional parent cast author FID (for replies)
   * @returns Cast hash and details
   */
  async publishCast(
    signerUuid: string,
    text: string,
    embeds?: { url: string }[],
    parent?: string,
    parentAuthorFid?: number
  ): Promise<{
    cast: {
      hash: string;
      author: { fid: number };
      text: string;
    };
  }> {
    try {
      const result = await this.client.publishCast({
        signerUuid,
        text,
        embeds,
        ...(parent && { parent }),
        ...(parentAuthorFid && { parentAuthorFid }),
      });
      
      return {
        cast: {
          hash: result.cast.hash,
          author: { fid: result.cast.author.fid },
          text: result.cast.text,
        },
      };
    } catch (error) {
      console.error('Error publishing cast:', error);
      throw new Error('Failed to publish cast');
    }
  }

  /**
   * Like a cast using an approved signer
   * 
   * @param signerUuid - UUID of an approved signer
   * @param castHash - Hash of the cast to like
   * @returns Success status
   */
  async likeCast(
    signerUuid: string,
    castHash: string
  ): Promise<{ success: boolean }> {
    try {
      await this.client.publishReaction({
        signerUuid,
        reactionType: 'like',
        target: castHash,
      });
      
      return { success: true };
    } catch (error) {
      console.error('Error liking cast:', error);
      throw new Error('Failed to like cast');
    }
  }

  /**
   * Unlike a cast using an approved signer
   * 
   * @param signerUuid - UUID of an approved signer
   * @param castHash - Hash of the cast to unlike
   * @returns Success status
   */
  async unlikeCast(
    signerUuid: string,
    castHash: string
  ): Promise<{ success: boolean }> {
    try {
      await this.client.deleteReaction({
        signerUuid,
        reactionType: 'like',
        target: castHash,
      });
      
      return { success: true };
    } catch (error) {
      console.error('Error unliking cast:', error);
      throw new Error('Failed to unlike cast');
    }
  }

  /**
   * Recast a cast using an approved signer
   * 
   * @param signerUuid - UUID of an approved signer
   * @param castHash - Hash of the cast to recast
   * @returns Success status
   */
  async recast(
    signerUuid: string,
    castHash: string
  ): Promise<{ success: boolean }> {
    try {
      await this.client.publishReaction({
        signerUuid,
        reactionType: 'recast',
        target: castHash,
      });
      
      return { success: true };
    } catch (error) {
      console.error('Error recasting:', error);
      throw new Error('Failed to recast');
    }
  }

  /**
   * Remove a recast using an approved signer
   * 
   * @param signerUuid - UUID of an approved signer
   * @param castHash - Hash of the cast to unrecast
   * @returns Success status
   */
  async unrecast(
    signerUuid: string,
    castHash: string
  ): Promise<{ success: boolean }> {
    try {
      await this.client.deleteReaction({
        signerUuid,
        reactionType: 'recast',
        target: castHash,
      });
      
      return { success: true };
    } catch (error) {
      console.error('Error removing recast:', error);
      throw new Error('Failed to remove recast');
    }
  }

  /**
   * Follow a user using an approved signer
   * 
   * @param signerUuid - UUID of an approved signer
   * @param targetFid - FID of the user to follow
   * @returns Success status with target FID
   */
  async followUser(
    signerUuid: string,
    targetFid: number
  ): Promise<{
    success: boolean;
    target_fid: number;
  }> {
    try {
      await this.client.followUser({
        signerUuid,
        targetFids: [targetFid],
      });
      
      return {
        success: true,
        target_fid: targetFid,
      };
    } catch (error) {
      console.error('Error following user:', error);
      throw new Error('Failed to follow user');
    }
  }

  /**
   * Unfollow a user using an approved signer
   * 
   * @param signerUuid - UUID of an approved signer
   * @param targetFid - FID of the user to unfollow
   * @returns Success status
   */
  async unfollowUser(
    signerUuid: string,
    targetFid: number
  ): Promise<{ success: boolean }> {
    try {
      await this.client.unfollowUser({
        signerUuid,
        targetFids: [targetFid],
      });
      
      return { success: true };
    } catch (error) {
      console.error('Error unfollowing user:', error);
      throw new Error('Failed to unfollow user');
    }
  }

  /**
   * Fetch cast conversation/replies using the Neynar API
   * 
   * @param castHash - Hash of the cast to get conversation for
   * @param viewerFid - Optional viewer FID for personalized responses
   * @param replyDepth - Depth of replies to fetch (default 1)
   * @param limit - Number of results to fetch (default 25)
   * @returns Cast conversation with direct replies and engagement data
   */
  async getCastConversation(
    castHash: string,
    viewerFid?: number,
    replyDepth: number = 1,
    limit: number = 25
  ): Promise<{
    cast: {
      hash: string;
      text: string;
      author: { fid: number; username: string; display_name: string; pfp_url?: string };
      timestamp: string;
      reactions: { likes_count: number; recasts_count: number };
      replies: { count: number };
    };
    replies: Array<{
      hash: string;
      text: string;
      author: { fid: number; username: string; display_name: string; pfp_url?: string };
      timestamp: string;
      reactions: { likes_count: number; recasts_count: number };
      replies: { count: number };
    }>;
  }> {
    try {
      const result = await this.client.lookupCastConversation({
        identifier: castHash,
        type: 'hash',
        replyDepth,
        limit,
        ...(viewerFid && { viewerFid }),
      });

      // Extract the parent cast and its direct replies
      const cast = result.conversation?.cast;
      if (!cast) {
        throw new Error('Cast not found');
      }

      // Map direct replies to a simpler format
      const replies = (cast.direct_replies || []).map((reply: any) => ({
        hash: reply.hash,
        text: reply.text,
        author: {
          fid: reply.author.fid,
          username: reply.author.username,
          display_name: reply.author.display_name,
          pfp_url: reply.author.pfp_url,
        },
        timestamp: reply.timestamp,
        reactions: {
          likes_count: reply.reactions?.likes_count || 0,
          recasts_count: reply.reactions?.recasts_count || 0,
        },
        replies: {
          count: reply.replies?.count || 0,
        },
      }));

      return {
        cast: {
          hash: cast.hash,
          text: cast.text,
          author: {
            fid: cast.author.fid,
            username: cast.author.username,
            display_name: cast.author.display_name,
            pfp_url: cast.author.pfp_url,
          },
          timestamp: cast.timestamp,
          // Include fresh reaction counts from Farcaster
          reactions: {
            likes_count: (cast as any).reactions?.likes_count || 0,
            recasts_count: (cast as any).reactions?.recasts_count || 0,
          },
          replies: {
            count: (cast as any).replies?.count || 0,
          },
        },
        replies,
      };
    } catch (error) {
      console.error('Error fetching cast conversation:', error);
      throw new Error('Failed to fetch cast conversation');
    }
  }
}

/**
 * Factory function to create a NeynarSignerService instance
 * Use this in your worker endpoints
 */
export function createSignerService(apiKey: string): NeynarSignerService {
  return new NeynarSignerService(apiKey);
}

