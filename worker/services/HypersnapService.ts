/**
 * HypersnapService — thin Neynar-compatible client for Farcaster reads + writes.
 *
 * Hypersnap exposes the Neynar v2 API shape against free/self-hostable
 * infrastructure. Short-term we talk to api.hypersnap.xyz; long-term we
 * self-host (roadmap Phase 5) and this client points at our own node.
 * See docs/hypersnap/data-layer.md.
 *
 * Signers use the managed-signer model (signer_uuid). Raw custody-key
 * signing is only needed against a self-hosted node without a managed
 * signer layer and is deferred; see docs/hypersnap/roadmap.md Phase 5.
 */

export interface HypersnapCast {
  hash: string;
  author: { fid: number; username?: string };
  text: string;
  parent_hash: string | null;
  embeds: Array<{ url?: string; cast_id?: { fid: number; hash: string } }>;
  timestamp: string;
}

export interface PublishCastResult {
  hash: string;
  author_fid: number;
  text: string;
}

export interface HypersnapOptions {
  endpoint: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

export class HypersnapService {
  private endpoint: string;
  private apiKey: string;
  private fetchImpl: typeof fetch;

  constructor(opts: HypersnapOptions) {
    this.endpoint = opts.endpoint.replace(/\/$/, '');
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async publishCast(params: {
    signerUuid: string;
    text: string;
    embeds?: Array<{ url: string }>;
    parentHash?: string;
    parentAuthorFid?: number;
  }): Promise<PublishCastResult> {
    const body: Record<string, unknown> = {
      signer_uuid: params.signerUuid,
      text: params.text,
    };
    if (params.embeds?.length) body.embeds = params.embeds;
    if (params.parentHash) body.parent = params.parentHash;
    if (params.parentAuthorFid) body.parent_author_fid = params.parentAuthorFid;

    const res = await this.post('/v2/farcaster/cast', body);
    const cast = res.cast ?? res;
    return {
      hash: cast.hash,
      author_fid: cast.author?.fid ?? cast.author_fid,
      text: cast.text,
    };
  }

  async deleteCast(params: { signerUuid: string; castHash: string }): Promise<void> {
    await this.del('/v2/farcaster/cast', {
      signer_uuid: params.signerUuid,
      target_hash: params.castHash,
    });
  }

  async getCastByHash(castHash: string): Promise<HypersnapCast | null> {
    const res = await this.get(`/v2/farcaster/cast?identifier=${encodeURIComponent(castHash)}&type=hash`);
    if (!res || !res.cast) return null;
    const c = res.cast;
    return {
      hash: c.hash,
      author: { fid: c.author.fid, username: c.author.username },
      text: c.text,
      parent_hash: c.parent_hash ?? null,
      embeds: c.embeds ?? [],
      timestamp: c.timestamp,
    };
  }

  async getReplies(castHash: string, limit = 25): Promise<HypersnapCast[]> {
    const res = await this.get(
      `/v2/farcaster/cast/conversation?identifier=${encodeURIComponent(castHash)}&type=hash&reply_depth=1&limit=${limit}`,
    );
    const direct = res?.conversation?.cast?.direct_replies ?? [];
    return direct.map((r: any) => ({
      hash: r.hash,
      author: { fid: r.author.fid, username: r.author.username },
      text: r.text,
      parent_hash: r.parent_hash ?? null,
      embeds: r.embeds ?? [],
      timestamp: r.timestamp,
    }));
  }

  private async get(path: string): Promise<any> {
    const res = await this.fetchImpl(`${this.endpoint}${path}`, {
      method: 'GET',
      headers: this.headers(),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new HypersnapError(res.status, await res.text());
    return res.json();
  }

  private async post(path: string, body: Record<string, unknown>): Promise<any> {
    const res = await this.fetchImpl(`${this.endpoint}${path}`, {
      method: 'POST',
      headers: { ...this.headers(), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new HypersnapError(res.status, await res.text());
    return res.json();
  }

  private async del(path: string, body: Record<string, unknown>): Promise<any> {
    const res = await this.fetchImpl(`${this.endpoint}${path}`, {
      method: 'DELETE',
      headers: { ...this.headers(), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new HypersnapError(res.status, await res.text());
    return res.status === 204 ? null : res.json();
  }

  private headers(): Record<string, string> {
    return {
      'x-api-key': this.apiKey,
      'accept': 'application/json',
    };
  }
}

export class HypersnapError extends Error {
  constructor(public status: number, public body: string) {
    super(`Hypersnap ${status}: ${body.slice(0, 200)}`);
    this.name = 'HypersnapError';
  }

  get isSignerRevoked(): boolean {
    return this.status === 403 && /signer.*revoked/i.test(this.body);
  }
}

export function createHypersnapService(env: {
  HYPERSNAP_ENDPOINT?: string;
  HYPERSNAP_API_KEY?: string;
}): HypersnapService {
  const endpoint = env.HYPERSNAP_ENDPOINT;
  const apiKey = env.HYPERSNAP_API_KEY;
  if (!endpoint) throw new Error('HYPERSNAP_ENDPOINT not configured');
  if (!apiKey) throw new Error('HYPERSNAP_API_KEY not configured');
  return new HypersnapService({ endpoint, apiKey });
}
