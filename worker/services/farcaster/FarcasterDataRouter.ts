/**
 * FarcasterDataRouter — priority-ordered fan-out over FarcasterDataProviders.
 *
 *   getUsers: asks providers in order; each fills the FIDs the previous ones
 *             missed, so a hub-first order still gets Neynar-only fields for
 *             nobody, and a neynar-first order still resolves FIDs Neynar has
 *             not indexed yet. A provider that throws is logged and skipped.
 *   capabilities (by-username, address→FID, channel search, besties): first
 *             provider that implements the method and does not throw wins.
 *
 * Order comes from `FC_DATA_PROVIDER_ORDER` (default `neynar,hub`). Flip it
 * to `hub,neynar` when the own node is trusted for profile reads.
 */

import {
  NoProviderError,
  type FarcasterChannel,
  type FarcasterDataProvider,
  type FarcasterUser,
  type GetUsersOptions,
} from './FarcasterDataProvider';
import { NeynarDataProvider } from './NeynarDataProvider';
import { HubDataProvider } from './HubDataProvider';

export class FarcasterDataRouter {
  private providers: FarcasterDataProvider[];

  constructor(providers: FarcasterDataProvider[]) {
    this.providers = providers;
  }

  listProviders(): string[] {
    return this.providers.map(p => p.name);
  }

  async getUsers(fids: number[], opts?: GetUsersOptions): Promise<FarcasterUser[]> {
    let remaining = Array.from(new Set(fids.filter(f => Number.isInteger(f) && f > 0)));
    const found: FarcasterUser[] = [];
    for (const p of this.providers) {
      if (remaining.length === 0) break;
      try {
        const users = await p.getUsers(remaining, opts);
        const got = new Set<number>();
        for (const u of users) {
          if (got.has(u.fid)) continue;
          got.add(u.fid);
          found.push(u);
        }
        remaining = remaining.filter(f => !got.has(f));
      } catch (err) {
        console.warn(`[FarcasterData] ${p.name}.getUsers failed: ${(err as Error)?.message ?? err}`);
      }
    }
    return found;
  }

  async getUser(fid: number, opts?: GetUsersOptions): Promise<FarcasterUser | null> {
    const users = await this.getUsers([fid], opts);
    return users.find(u => u.fid === fid) ?? null;
  }

  /** `pfp_url` for a FID, or null. The most common question the app asks. */
  async getAvatarUrl(fid: number): Promise<string | null> {
    return (await this.getUser(fid))?.pfp_url ?? null;
  }

  async getUserByUsername(username: string): Promise<FarcasterUser | null> {
    // `return await` (not bare `return`): workerd flags a promise that rejects
    // before the async wrapper adopts it as an unhandled rejection.
    return await this.first('getUserByUsername', p => p.getUserByUsername!(username), null);
  }

  async getFidsByAddresses(addresses: string[]): Promise<number[]> {
    if (addresses.length === 0) return [];
    // `return await` (not bare `return`): workerd flags a promise that rejects
    // before the async wrapper adopts it as an unhandled rejection.
    return await this.first('getFidsByAddresses', p => p.getFidsByAddresses!(addresses));
  }

  async searchChannels(query: string, limit = 10): Promise<FarcasterChannel[]> {
    // `return await` (not bare `return`): workerd flags a promise that rejects
    // before the async wrapper adopts it as an unhandled rejection.
    return await this.first('searchChannels', p => p.searchChannels!(query, limit), []);
  }

  async getBestFriends(fid: number, limit = 50): Promise<number[]> {
    // `return await` (not bare `return`): workerd flags a promise that rejects
    // before the async wrapper adopts it as an unhandled rejection.
    return await this.first('getBestFriends', p => p.getBestFriends!(fid, limit));
  }

  /**
   * Run `fn` on the first provider that has `capability`; on failure try the
   * next. With a `fallback`, exhausting providers returns it; without one it
   * throws (the last error, or NoProviderError when nobody had the capability).
   */
  private async first<T>(
    capability: keyof FarcasterDataProvider,
    fn: (p: FarcasterDataProvider) => Promise<T>,
    fallback?: T,
  ): Promise<T> {
    let lastErr: unknown = null;
    let tried = 0;
    for (const p of this.providers) {
      if (typeof p[capability] !== 'function') continue;
      tried++;
      try {
        return await fn(p);
      } catch (err) {
        lastErr = err;
        console.warn(`[FarcasterData] ${p.name}.${String(capability)} failed: ${(err as Error)?.message ?? err}`);
      }
    }
    if (fallback !== undefined) return fallback;
    if (tried === 0 || lastErr === null) throw new NoProviderError(String(capability));
    throw lastErr;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface InitFarcasterDataOptions {
  /** Use a different Neynar key than `env.NEYNAR_API_KEY` (Q's agent key). */
  neynarApiKey?: string;
  fetchImpl?: typeof fetch;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

/**
 * Build the router from env. Order: `FC_DATA_PROVIDER_ORDER` (comma list of
 * `neynar` / `hub`), default `neynar,hub`. A provider whose config is missing
 * is skipped. Throws when nothing is configured — every deployment must be
 * able to resolve a FID to a profile.
 */
export function initFarcasterData(env: Env, opts: InitFarcasterDataOptions = {}): FarcasterDataRouter {
  const order = String(env?.FC_DATA_PROVIDER_ORDER ?? 'neynar,hub')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
  const providers: FarcasterDataProvider[] = [];
  for (const name of order) {
    if (name === 'neynar') {
      const apiKey = opts.neynarApiKey ?? env?.NEYNAR_API_KEY;
      if (apiKey) providers.push(new NeynarDataProvider({ apiKey, fetchImpl: opts.fetchImpl }));
    } else if (name === 'hub') {
      const hubEndpoint = env?.HUB_ENDPOINT;
      if (hubEndpoint) providers.push(new HubDataProvider({ hubEndpoint, fetchImpl: opts.fetchImpl }));
    } else {
      console.warn(`[FarcasterData] unknown provider "${name}" in FC_DATA_PROVIDER_ORDER`);
    }
  }
  if (providers.length === 0) {
    throw new Error('No Farcaster data providers configured. Set NEYNAR_API_KEY and/or HUB_ENDPOINT.');
  }
  return new FarcasterDataRouter(providers);
}
