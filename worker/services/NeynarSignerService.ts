/**
 * Neynar Signer Service (Worker-safe, no SDK dependency)
 *
 * Manages Neynar-managed signers for existing Farcaster users.
 * Uses raw REST calls to Neynar API + viem for EIP-712 signing.
 *
 * Flow:
 * 1. User authenticates via Farcaster AuthKit (SIWF) → we get their FID
 * 2. Local script creates signer + registers signed key (EIP-712, seed phrase stays local)
 * 3. Store signer_uuid in D1 user_signers table
 * 4. User approves signer via Farcaster client (farcaster.xyz)
 * 5. Worker polls status endpoint until signer is approved
 * 6. User casts go through Neynar API with approved signer_uuid
 *
 * Security: Seed phrase never enters the worker. Signer creation + EIP-712
 * registration happens locally via scripts/create-neynar-signer.ts.
 *
 * Unlike the old service, this does NOT import @neynar/nodejs-sdk
 * (which calls randomBytes at module init, breaking CF Workers).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NeynarSignerResult {
  signer_uuid: string;
  public_key: string;
  status: 'pending_approval' | 'approved' | 'revoked';
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

  constructor(apiKey: string, fetchImpl?: typeof fetch) {
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  // -------------------------------------------------------------------------
  // Signer management
  // -------------------------------------------------------------------------

  /**
   * Create a new signer via Neynar.
   * Returns a signer_uuid and public_key. The signer is in 'pending_approval' state.
   */
  async createSigner(): Promise<{ signer_uuid: string; public_key: string }> {
    const res = await this.post('/signer', {});
    return {
      signer_uuid: res.signer_uuid,
      public_key: res.public_key,
    };
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
}): NeynarSignerService {
  const apiKey = env.NEYNAR_API_KEY;
  if (!apiKey) throw new Error('NEYNAR_API_KEY not configured');
  return new NeynarSignerService(apiKey);
}
