/**
 * NeynarDataProvider — a Neynar-compatible `/v2/farcaster` REST API as a
 * FarcasterDataProvider.
 *
 * Two deployments speak this API:
 *   - Neynar itself (`api.neynar.com`, needs `x-api-key`): the only source for
 *     `score`, `pro`, `power_badge`, `viewer_context` and affinity-ranked
 *     best friends.
 *   - Hypersnap (Haatz `haatz.quilibrium.com/v2/farcaster`, no key): protocol-
 *     derived data only — profiles, follower counts, verifications,
 *     address→FID, by-username, recency-ranked best friends. It deliberately
 *     does not implement Neynar's proprietary fields, so a Hypersnap instance
 *     declares them in `lacks` and the router enriches from Neynar on demand.
 *
 * Endpoints used, and nowhere else in the worker:
 *   GET /user/bulk                 users by FID (+ viewer_context on Neynar)
 *   GET /user/by_username          exact fname lookup
 *   GET /user/bulk-by-address      address → FID
 *   GET /channel/search            channel search
 *   GET /user/best_friends         besties
 *
 * `fetchImpl` is injectable for tests; the constructor takes the key so the
 * same class serves the app key and Q's own key (`QGENT_NEYNAR_API_KEY`).
 */

import type {
  FarcasterChannel,
  FarcasterDataProvider,
  FarcasterUser,
  GetUsersOptions,
  ProviderOnlyField,
  Relationship,
} from './FarcasterDataProvider';

export const NEYNAR_BASE = 'https://api.neynar.com/v2/farcaster';
/** Neynar caps `user/bulk` at 100 FIDs per call. */
const BULK_FIDS_MAX = 100;
/** Neynar caps `user/bulk-by-address` at 350 addresses per call. */
const BULK_ADDRESSES_MAX = 350;

/** What Hypersnap's Neynar-compatible API does not compute (verified against Haatz 2026-09-07). */
export const HYPERSNAP_LACKS: ReadonlySet<ProviderOnlyField> = new Set<ProviderOnlyField>([
  'score', 'pro', 'power_badge', 'viewer_context',
]);

export interface NeynarDataProviderOptions {
  /** Required for Neynar; omit for a keyless Hypersnap instance. */
  apiKey?: string;
  /** Defaults to Neynar. Point at `<hypersnap>/v2/farcaster` for Haatz / own node. */
  baseUrl?: string;
  /** Provider label stamped on every user. Defaults to `neynar`. */
  name?: string;
  /** Fields this deployment never returns. Defaults to none for Neynar. */
  lacks?: ReadonlySet<ProviderOnlyField>;
  fetchImpl?: typeof fetch;
}

/** The subset of the Neynar-shaped user object we read. */
interface NeynarWireUser {
  fid: number;
  username?: string;
  display_name?: string;
  pfp_url?: string;
  custody_address?: string;
  profile?: { bio?: { text?: string } };
  follower_count?: number;
  following_count?: number;
  verified_addresses?: FarcasterUser['verified_addresses'];
  score?: number;
  experimental?: { neynar_user_score?: number };
  power_badge?: boolean;
  pro?: FarcasterUser['pro'];
  viewer_context?: { following: boolean; followed_by: boolean };
}

export class NeynarError extends Error {
  status: number;
  constructor(status: number, body: string, path: string, host: string) {
    super(`${host} ${status} on ${path}: ${body.slice(0, 200)}`);
    this.name = 'NeynarError';
    this.status = status;
  }
}

export class NeynarDataProvider implements FarcasterDataProvider {
  readonly name: string;
  readonly lacks?: ReadonlySet<ProviderOnlyField>;
  private apiKey?: string;
  private base: string;
  private fetchImpl: typeof fetch;

  constructor(opts: NeynarDataProviderOptions) {
    this.name = opts.name ?? 'neynar';
    this.base = (opts.baseUrl ?? NEYNAR_BASE).replace(/\/$/, '');
    if (this.base === NEYNAR_BASE && !opts.apiKey) {
      throw new Error('NeynarDataProvider: apiKey is required for api.neynar.com');
    }
    this.apiKey = opts.apiKey || undefined;
    this.lacks = opts.lacks;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    if (!this.lacks?.has('viewer_context')) {
      this.getRelationship = (fid, targetFid) => this.relationshipFromViewerContext(fid, targetFid);
    }
  }

  async getUsers(fids: number[], opts?: GetUsersOptions): Promise<FarcasterUser[]> {
    const unique = Array.from(new Set(fids.filter(f => Number.isInteger(f) && f > 0)));
    if (unique.length === 0) return [];
    const out: FarcasterUser[] = [];
    for (let i = 0; i < unique.length; i += BULK_FIDS_MAX) {
      const batch = unique.slice(i, i + BULK_FIDS_MAX);
      const viewer = opts?.viewerFid ? `&viewer_fid=${opts.viewerFid}` : '';
      const data = await this.get<{ users?: NeynarWireUser[] }>(`/user/bulk?fids=${batch.join(',')}${viewer}`);
      for (const u of data.users ?? []) out.push(this.toUser(u));
    }
    return out;
  }

  /**
   * Follow edges from Neynar's viewer_context (Track C card C10 fallback; the
   * hub's link messages are preferred). Absent on an instance that lacks
   * viewer_context (Hypersnap), so the router skips it.
   */
  getRelationship?: (fid: number, targetFid: number) => Promise<Relationship>;

  private async relationshipFromViewerContext(fid: number, targetFid: number): Promise<Relationship> {
    const [user] = await this.getUsers([targetFid], { viewerFid: fid });
    if (!user?.viewer_context) throw new Error(`${this.name}: no viewer_context for ${targetFid} as seen by ${fid}`);
    return { following: !!user.viewer_context.following, followed_by: !!user.viewer_context.followed_by };
  }

  async getUserByUsername(username: string): Promise<FarcasterUser | null> {
    try {
      const data = await this.get<{ user?: NeynarWireUser }>(
        `/user/by_username?username=${encodeURIComponent(username)}`,
      );
      return data.user ? this.toUser(data.user) : null;
    } catch (err) {
      if (err instanceof NeynarError && err.status === 404) return null;
      throw err;
    }
  }

  async getFidsByAddresses(addresses: string[]): Promise<number[]> {
    const unique = Array.from(new Set(addresses.map(a => a.toLowerCase())));
    if (unique.length === 0) return [];
    const fids = new Set<number>();
    for (let i = 0; i < unique.length; i += BULK_ADDRESSES_MAX) {
      const batch = unique.slice(i, i + BULK_ADDRESSES_MAX);
      const data = await this.get<Record<string, Array<{ fid?: number }>>>(
        `/user/bulk-by-address?addresses=${batch.join(',')}`,
      );
      for (const users of Object.values(data)) {
        if (!Array.isArray(users)) continue;
        for (const u of users) if (typeof u.fid === 'number') fids.add(u.fid);
      }
    }
    return Array.from(fids).sort((a, b) => a - b);
  }

  async searchChannels(query: string, limit: number): Promise<FarcasterChannel[]> {
    const data = await this.get<{ channels?: FarcasterChannel[] }>(
      `/channel/search?q=${encodeURIComponent(query)}&limit=${Math.max(1, Math.min(limit, 20))}`,
    );
    return data.channels ?? [];
  }

  async getBestFriends(fid: number, limit: number): Promise<number[]> {
    const data = await this.get<{ users?: Array<{ fid: number }> }>(
      `/user/best_friends?fid=${fid}&limit=${Math.max(1, Math.min(limit, 50))}`,
    );
    return (data.users ?? []).map(u => u.fid);
  }

  private async get<T>(path: string): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.apiKey) {
      headers['x-api-key'] = this.apiKey;
      headers['x-neynar-experimental'] = 'true';
    }
    const res = await this.fetchImpl(`${this.base}${path}`, { headers });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new NeynarError(res.status, body, path.split('?')[0], this.name);
    }
    return (await res.json()) as T;
  }

  private toUser(u: NeynarWireUser): FarcasterUser {
    const out: FarcasterUser = { fid: u.fid, provider: this.name };
    if (u.username) out.username = u.username;
    if (u.display_name) out.display_name = u.display_name;
    if (u.pfp_url) out.pfp_url = u.pfp_url;
    if (u.custody_address) out.custody_address = u.custody_address;
    if (u.profile) out.profile = u.profile;
    if (typeof u.follower_count === 'number') out.follower_count = u.follower_count;
    if (typeof u.following_count === 'number') out.following_count = u.following_count;
    if (u.verified_addresses) out.verified_addresses = u.verified_addresses;
    const score = typeof u.score === 'number' ? u.score : u.experimental?.neynar_user_score;
    if (typeof score === 'number') out.score = score;
    if (typeof u.power_badge === 'boolean') out.power_badge = u.power_badge;
    if (u.pro) out.pro = u.pro;
    if (u.viewer_context) out.viewer_context = u.viewer_context;
    return out;
  }
}
