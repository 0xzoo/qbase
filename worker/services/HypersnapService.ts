/**
 * HypersnapService — Farcaster reads via public Hypersnap API + writes via hub protocol.
 *
 * Reads: unauthenticated GETs against Hypersnap (https://haatz.quilibrium.com).
 * Writes: protobuf-signed CastAdd/CastRemove messages submitted to the hub's /v1/submitMessage.
 *
 * Signer keys are Ed25519 private keys (0x-prefixed hex) stored as wrangler secrets.
 * Hub writes use FarcasterHubWriter (minimal, Worker-safe) instead of @farcaster/core,
 * which triggers module-level randomBytes that breaks in Cloudflare Workers.
 *
 * See docs/hypersnap/data-layer.md, docs/hypersnap/roadmap.md.
 */

import {
  makeCastAddMessage,
  makeCastRemoveMessage,
  bytesToHex,
} from './FarcasterHubWriter';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HypersnapCast {
  hash: string;
  author: { fid: number; username?: string };
  text: string;
  parent_hash: string | null;
  parent_url: string | null;
  embeds: Array<{ url?: string; cast_id?: { fid: number; hash: string } }>;
  timestamp: string;
}

export interface PublishCastParams {
  signerKey: string;        // 0x-prefixed Ed25519 private key
  fid: number;              // FID that owns the signer
  text: string;
  embeds?: Array<{ url: string }>;
  parentHash?: string;      // reply-to cast hash
  parentAuthorFid?: number; // reply-to author FID (required when parentHash is set)
}

export interface PublishCastResult {
  hash: string;
  author_fid: number;
  text: string;
}

export interface HypersnapServiceOptions {
  endpoint: string;       // e.g. https://haatz.quilibrium.com
  hubEndpoint?: string;   // defaults to endpoint (same host acts as hub)
  fetchImpl?: typeof fetch;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class HypersnapService {
  private endpoint: string;
  private hubEndpoint: string;
  private fetchImpl: typeof fetch;

  constructor(opts: HypersnapServiceOptions) {
    this.endpoint = opts.endpoint.replace(/\/$/, '');
    this.hubEndpoint = (opts.hubEndpoint ?? opts.endpoint).replace(/\/$/, '');
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  // -----------------------------------------------------------------------
  // Writes — hub protocol via FarcasterHubWriter (no @farcaster/core)
  // -----------------------------------------------------------------------

  async publishCast(params: PublishCastParams): Promise<PublishCastResult> {
    const encoded = makeCastAddMessage(
      {
        text: params.text,
        embeds: params.embeds,
        parentHash: params.parentHash,
        parentAuthorFid: params.parentAuthorFid,
      },
      { fid: params.fid, network: 1 }, // 1 = MAINNET
      params.signerKey,
    );

    const res = await this.fetchImpl(`${this.hubEndpoint}/v1/submitMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: encoded,
    });

    if (!res.ok) {
      const body = await res.text();
      throw new HypersnapError(res.status, body);
    }

    const json = await res.json() as any;

    // Hub returns the message data; extract the hash
    const hash = json.hash
      ?? (json.data?.hashBytes ? bufToHex(json.data.hashBytes) : null)
      ?? bytesToHex(encoded.slice(0, 20)); // fallback to first 20 bytes (blake3 hash)

    return {
      hash,
      author_fid: params.fid,
      text: params.text,
    };
  }

  async deleteCast(params: { signerKey: string; fid: number; castHash: string }): Promise<void> {
    const encoded = makeCastRemoveMessage(
      { targetHash: params.castHash },
      { fid: params.fid, network: 1 }, // 1 = MAINNET
      params.signerKey,
    );

    const res = await this.fetchImpl(`${this.hubEndpoint}/v1/submitMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: encoded,
    });

    if (!res.ok) {
      const body = await res.text();
      throw new HypersnapError(res.status, body);
    }
  }

  // -----------------------------------------------------------------------
  // Reads — public Hypersnap API (no auth)
  // -----------------------------------------------------------------------

  async getCastByHash(castHash: string): Promise<HypersnapCast | null> {
    const res = await this.get(`/v2/farcaster/cast?identifier=${encodeURIComponent(castHash)}&type=hash`);
    if (!res || !res.cast) return null;
    return normalizeCast(res.cast);
  }

  async getReplies(castHash: string, limit = 25): Promise<HypersnapCast[]> {
    const res = await this.get(
      `/v2/farcaster/cast/conversation?identifier=${encodeURIComponent(castHash)}&type=hash&reply_depth=1&limit=${limit}`,
    );
    const direct = res?.replies ?? [];
    return direct.map((r: any) => normalizeCast(r.cast ?? r));
  }

  async getCastRepliesByParent(parentHash: string, limit = 50): Promise<HypersnapCast[]> {
    const res = await this.get(
      `/v2/farcaster/cast/conversation?identifier=${encodeURIComponent(parentHash)}&type=hash&reply_depth=1&limit=${limit}`,
    );
    const replies = res?.replies ?? [];
    return replies.map((r: any) => normalizeCast(r.cast ?? r));
  }

  // -----------------------------------------------------------------------
  // HTTP helpers
  // -----------------------------------------------------------------------

  private async get(path: string): Promise<any> {
    const res = await this.fetchImpl(`${this.endpoint}${path}`, {
      method: 'GET',
      headers: { accept: 'application/json' },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new HypersnapError(res.status, await res.text());
    return res.json();
  }
}

// ---------------------------------------------------------------------------
// Normalizers
// ---------------------------------------------------------------------------

function normalizeCast(c: any): HypersnapCast {
  return {
    hash: c.hash ?? '',
    author: { fid: c.author?.fid ?? 0, username: c.author?.username },
    text: c.text ?? '',
    parent_hash: c.parent_hash ?? null,
    parent_url: c.parent_url ?? null,
    embeds: c.embeds ?? [],
    timestamp: c.timestamp ?? '',
  };
}

function bufToHex(bytes: number[] | Uint8Array | string): string {
  if (typeof bytes === 'string') return bytes;
  return '0x' + Array.from(bytes as Uint8Array)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class HypersnapError extends Error {
  status: number;
  body: string;

  constructor(status: number, body: string) {
    super(`Hypersnap ${status}: ${body.slice(0, 200)}`);
    this.name = 'HypersnapError';
    this.status = status;
    this.body = body;
  }

  get isSignerRevoked(): boolean {
    return this.status === 403 && /signer.*revoked/i.test(this.body);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createHypersnapService(env: {
  HYPERSNAP_ENDPOINT?: string;
  HUB_ENDPOINT?: string;
}): HypersnapService {
  const endpoint = env.HYPERSNAP_ENDPOINT;
  if (!endpoint) throw new Error('HYPERSNAP_ENDPOINT not configured');
  return new HypersnapService({
    endpoint,
    hubEndpoint: env.HUB_ENDPOINT,
  });
}
