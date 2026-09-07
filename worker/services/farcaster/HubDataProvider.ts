/**
 * HubDataProvider — a Farcaster hub's HTTP API as a FarcasterDataProvider.
 *
 * Talks to `HUB_ENDPOINT` (Haatz today, our own node when C2 lands). A hub
 * holds the protocol's own data, so it can answer:
 *   GET /v1/userDataByFid?fid=          username, display, pfp, bio
 *   GET /v1/verificationsByFid?fid=     verified ETH/SOL addresses
 *   GET /v1/userNameProofByName?name=   fname → FID
 *
 * It cannot answer anything Neynar computes off-protocol: score, pro,
 * follower counts (needs a full-graph index), address → FID (reverse index),
 * channel search, best friends. Those capabilities are left unimplemented so
 * the router falls through to a provider that has them.
 */

import type { FarcasterDataProvider, FarcasterUser } from './FarcasterDataProvider';

export interface HubDataProviderOptions {
  hubEndpoint: string;
  fetchImpl?: typeof fetch;
  /** Parallel FID lookups per getUsers call. */
  concurrency?: number;
}

interface HubMessage<TBody extends string, TData> {
  data: { type: string; fid: number } & Record<TBody, TData>;
}

interface UserDataBody {
  type: string;
  value: string;
}

interface VerificationBody {
  address: string;
  protocol?: string;
}

export class HubDataProvider implements FarcasterDataProvider {
  readonly name = 'hub';
  private base: string;
  private fetchImpl: typeof fetch;
  private concurrency: number;

  constructor(opts: HubDataProviderOptions) {
    if (!opts.hubEndpoint) throw new Error('HubDataProvider: hubEndpoint is required');
    this.base = opts.hubEndpoint.replace(/\/$/, '');
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.concurrency = Math.max(1, opts.concurrency ?? 8);
  }

  async getUsers(fids: number[]): Promise<FarcasterUser[]> {
    const unique = Array.from(new Set(fids.filter(f => Number.isInteger(f) && f > 0)));
    const out: FarcasterUser[] = [];
    for (let i = 0; i < unique.length; i += this.concurrency) {
      const batch = unique.slice(i, i + this.concurrency);
      const users = await Promise.all(batch.map(fid => this.getUser(fid)));
      for (const u of users) if (u) out.push(u);
    }
    return out;
  }

  async getUserByUsername(username: string): Promise<FarcasterUser | null> {
    const proof = await this.get<{ fid?: number }>(`/v1/userNameProofByName?name=${encodeURIComponent(username)}`);
    if (!proof || typeof proof.fid !== 'number') return null;
    return this.getUser(proof.fid);
  }

  /** One FID: user data + verifications. Null when the hub has no record. */
  private async getUser(fid: number): Promise<FarcasterUser | null> {
    const [userData, verifications] = await Promise.all([
      this.get<{ messages?: Array<HubMessage<'userDataBody', UserDataBody>> }>(`/v1/userDataByFid?fid=${fid}`),
      this.get<{ messages?: Array<HubMessage<'verificationAddAddressBody', VerificationBody>> }>(
        `/v1/verificationsByFid?fid=${fid}&pageSize=100`,
      ),
    ]);
    const fields = userData?.messages ?? [];
    if (fields.length === 0) return null;

    const user: FarcasterUser = { fid, provider: 'hub' };
    for (const m of fields) {
      const body = m.data?.userDataBody;
      if (!body || typeof body.value !== 'string') continue;
      switch (body.type) {
        case 'USER_DATA_TYPE_USERNAME': if (body.value) user.username = body.value; break;
        case 'USER_DATA_TYPE_DISPLAY': if (body.value) user.display_name = body.value; break;
        case 'USER_DATA_TYPE_PFP': if (body.value) user.pfp_url = body.value; break;
        case 'USER_DATA_TYPE_BIO': user.profile = { bio: { text: body.value } }; break;
        case 'USER_DATA_PRIMARY_ADDRESS_ETHEREUM':
          if (body.value) {
            user.verified_addresses ??= {};
            user.verified_addresses.primary = { ...(user.verified_addresses.primary ?? {}), eth_address: body.value };
          }
          break;
        default: break;
      }
    }

    const eth: string[] = [];
    const sol: string[] = [];
    for (const m of verifications?.messages ?? []) {
      const body = m.data?.verificationAddAddressBody;
      if (!body?.address) continue;
      if (body.protocol === 'PROTOCOL_SOLANA') sol.push(body.address);
      else eth.push(body.address);
    }
    if (eth.length || sol.length) {
      user.verified_addresses ??= {};
      if (eth.length) user.verified_addresses.eth_addresses = eth;
      if (sol.length) user.verified_addresses.sol_addresses = sol;
    }
    return user;
  }

  /** Hub errors (unknown FID, unknown name) come back as non-2xx with an errCode body; treat as "no data". */
  private async get<T>(path: string): Promise<T | null> {
    const res = await this.fetchImpl(`${this.base}${path}`, { headers: { accept: 'application/json' } });
    if (!res.ok) {
      if (res.status >= 500) {
        const body = await res.text().catch(() => '');
        throw new Error(`Hub ${res.status} on ${path.split('?')[0]}: ${body.slice(0, 200)}`);
      }
      return null;
    }
    return (await res.json()) as T;
  }
}
