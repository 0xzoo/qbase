/**
 * Neynar Signer Service (Worker-safe, no SDK dependency)
 *
 * Manages Neynar-managed signers for existing Farcaster users.
 * Uses raw REST calls to Neynar API + viem for EIP-712 signing.
 *
 * Full flow (when FARCASTER_DEVELOPER_MNEMONIC is set):
 * 1. POST /signer → create signer (status: "generated")
 * 2. GET /user/bycustody → look up app FID from custody address
 * 3. EIP-712 sign (app_fid, deadline, public_key) with custody wallet
 * 4. POST /signer/signed_key → register signed key (status: "pending_approval", gets approval_url)
 *
 * Degraded flow (no mnemonic):
 * 1. POST /signer → create signer only (no approval_url, stuck in "generated")
 *
 * Unlike the old service, this does NOT import @neynar/nodejs-sdk
 * (which calls randomBytes at module init, breaking CF Workers).
 */

import { mnemonicToAccount } from 'viem/accounts';

// ---------------------------------------------------------------------------
// EIP-712 constants for Farcaster SignedKeyRequestValidator
// Contract: 0x00000000fc700472606ed4fa22623acf62c60553 (Optimism Mainnet)
// ---------------------------------------------------------------------------

const SIGNED_KEY_REQUEST_VALIDATOR_EIP_712_DOMAIN = {
  name: 'Farcaster SignedKeyRequestValidator',
  version: '1',
  chainId: 10, // Optimism Mainnet
  verifyingContract: '0x00000000fc700472606ed4fa22623acf62c60553' as const,
} as const;

const SIGNED_KEY_REQUEST_TYPE = [
  { name: 'requestFid', type: 'uint256' },
  { name: 'key', type: 'bytes' },
  { name: 'deadline', type: 'uint256' },
] as const;

const DEFAULT_SIGNED_KEY_DEADLINE = 86400; // 24 hours

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NeynarSignerResult {
  signer_uuid: string;
  public_key: string;
  status: 'generated' | 'pending_approval' | 'approved' | 'revoked';
  signer_approval_url?: string;
  fid?: number;
}

export interface PublishCastParams {
  signerUuid: string;
  text: string;
  embeds?: Array<{ url: string }>;
  parent?: string;
  parentAuthorFid?: number;
}

export interface PublishCastResult {
  hash: string;
  author_fid: number;
  text: string;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

const NEYNAR_BASE = 'https://api.neynar.com/v2/farcaster';

export class NeynarSignerService {
  private apiKey: string;
  private fetchImpl: typeof fetch;
  private mnemonic?: string;

  constructor(apiKey: string, fetchImpl?: typeof fetch, mnemonic?: string) {
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.mnemonic = mnemonic;
  }

  // -------------------------------------------------------------------------
  // Signer management
  // -------------------------------------------------------------------------

  /**
   * Create a new signer + register signed key (full flow).
   * Returns signer_uuid, public_key, and the real approval URL.
   *
   * Falls back to create-only (no approval URL) if mnemonic is not set.
   */
  async createSigner(): Promise<{ signer_uuid: string; public_key: string; signer_approval_url: string }> {
    // Step 1: Create signer
    const createRes = await this.post('/signer', {});
    const signerUuid: string = createRes.signer_uuid;
    const publicKey: string = createRes.public_key;

    // If no mnemonic, we can't register the signed key — return what we have
    if (!this.mnemonic) {
      console.warn('[NeynarSignerService] No FARCASTER_DEVELOPER_MNEMONIC set — signer created but not registered (no approval URL)');
      return {
        signer_uuid: signerUuid,
        public_key: publicKey,
        signer_approval_url: '',
      };
    }

    try {
      // Step 2: Look up app FID from custody address
      const account = mnemonicToAccount(this.mnemonic);
      const userRes = await this.get(`/user/bycustody?address=${account.address}`);
      const appFid = userRes.user?.fid;
      if (!appFid) {
        console.error(`[NeynarSignerService] No Farcaster account found for custody address ${account.address}`);
        return { signer_uuid: signerUuid, public_key: publicKey, signer_approval_url: '' };
      }

      // Step 3: Generate EIP-712 signature
      const deadline = Math.floor(Date.now() / 1000) + DEFAULT_SIGNED_KEY_DEADLINE;
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

      // Step 4: Register signed key with Neynar
      const registerRes = await this.post('/signer/signed_key', {
        signer_uuid: signerUuid,
        app_fid: appFid,
        deadline,
        signature,
      });

      const approvalUrl: string = registerRes.signer_approval_url ?? '';
      console.log(`[NeynarSignerService] Signer ${signerUuid} registered for app FID ${appFid}, approval URL: ${approvalUrl ? 'yes' : 'MISSING'}`);

      return {
        signer_uuid: signerUuid,
        public_key: publicKey,
        signer_approval_url: approvalUrl,
      };
    } catch (err: any) {
      console.error('[NeynarSignerService] Failed to register signed key:', err.message);
      // Return the signer without approval URL — it exists but can't be approved
      return {
        signer_uuid: signerUuid,
        public_key: publicKey,
        signer_approval_url: '',
      };
    }
  }

  /**
   * Look up the status of a signer.
   */
  async lookupSigner(signerUuid: string): Promise<NeynarSignerResult> {
    const res = await this.get(`/signer?signer_uuid=${encodeURIComponent(signerUuid)}`);
    return {
      signer_uuid: res.signer_uuid,
      public_key: res.public_key,
      status: res.status as NeynarSignerResult['status'],
      fid: res.fid,
    };
  }

  // -------------------------------------------------------------------------
  // Cast publishing (via Neynar, using user's approved signer)
  // -------------------------------------------------------------------------

  /**
   * Publish a cast using an approved signer.
   */
  async publishCast(params: PublishCastParams): Promise<PublishCastResult> {
    const body: Record<string, any> = {
      signer_uuid: params.signerUuid,
      text: params.text,
    };

    if (params.embeds?.length) {
      body.embeds = params.embeds;
    }
    if (params.parent) {
      body.parent = params.parent;
      if (params.parentAuthorFid) {
        body.parent_author_fid = params.parentAuthorFid;
      }
    }

    const res = await this.post('/cast', body);

    return {
      hash: res.cast?.hash ?? '',
      author_fid: res.cast?.author?.fid ?? 0,
      text: res.cast?.text ?? params.text,
    };
  }

  // -------------------------------------------------------------------------
  // Reactions (likes / recasts) via user's approved signer
  // -------------------------------------------------------------------------

  async publishReaction(params: {
    signerUuid: string;
    reactionType: 'like' | 'recast';
    targetCastHash: string;
  }): Promise<void> {
    await this.post('/reaction', {
      signer_uuid: params.signerUuid,
      reaction_type: params.reactionType,
      target: params.targetCastHash,
    });
  }

  async removeReaction(params: {
    signerUuid: string;
    reactionType: 'like' | 'recast';
    targetCastHash: string;
  }): Promise<void> {
    await this.del('/reaction', {
      signer_uuid: params.signerUuid,
      reaction_type: params.reactionType,
      target: params.targetCastHash,
    });
  }

  // -------------------------------------------------------------------------
  // HTTP helpers
  // -------------------------------------------------------------------------

  private async get(path: string): Promise<any> {
    const res = await this.fetchImpl(`${NEYNAR_BASE}${path}`, {
      method: 'GET',
      headers: {
        'x-api-key': this.apiKey,
        'accept': 'application/json',
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new NeynarSignerError(res.status, body);
    }
    return res.json();
  }

  private async post(path: string, body: Record<string, any>): Promise<any> {
    const res = await this.fetchImpl(`${NEYNAR_BASE}${path}`, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'content-type': 'application/json',
        'accept': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new NeynarSignerError(res.status, text);
    }
    return res.json();
  }

  private async del(path: string, body: Record<string, any>): Promise<any> {
    const res = await this.fetchImpl(`${NEYNAR_BASE}${path}`, {
      method: 'DELETE',
      headers: {
        'x-api-key': this.apiKey,
        'content-type': 'application/json',
        'accept': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new NeynarSignerError(res.status, text);
    }
    // Some DELETE responses have no body
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  }
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class NeynarSignerError extends Error {
  status: number;
  body: string;

  constructor(status: number, body: string) {
    super(`Neynar ${status}: ${body.slice(0, 200)}`);
    this.name = 'NeynarSignerError';
    this.status = status;
    this.body = body;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createNeynarSignerService(env: {
  NEYNAR_API_KEY?: string;
  FARCASTER_DEVELOPER_MNEMONIC?: string;
}): NeynarSignerService {
  const apiKey = env.NEYNAR_API_KEY;
  if (!apiKey) throw new Error('NEYNAR_API_KEY not configured');
  return new NeynarSignerService(apiKey, undefined, env.FARCASTER_DEVELOPER_MNEMONIC);
}
