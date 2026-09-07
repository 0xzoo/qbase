/**
 * FarcasterDataRouter — priority-ordered fan-out over FarcasterDataProviders.
 *
 *   getUsers: asks providers in order; each fills the FIDs the previous ones
 *             missed. When the caller passes `need` and the answering provider
 *             `lacks` one of those fields, a later provider that has it is
 *             asked for just those FIDs and the fields are merged in — so a
 *             Hypersnap-first order still gets `pro` from Neynar where a
 *             caller reads it. A provider that throws is logged and skipped.
 *   getFidsByAddresses: the UNION over every provider that implements it —
 *             a holder-gate snapshot wants the most complete FID set, and
 *             each source indexes addresses slightly differently.
 *   other capabilities (by-username, channel search, besties): first
 *             provider that implements the method and does not throw wins.
 *
 * Order comes from `FC_DATA_PROVIDER_ORDER`; default `hypersnap,neynar,hub`
 * (Zoo, 2026-09-07: depend on Haatz for as much as possible). Set it to
 * `neynar,hypersnap,hub` to put Neynar back in front.
 */

import {
  type Relationship,
  NoProviderError,
  type FarcasterChannel,
  type FarcasterDataProvider,
  type FarcasterUser,
  type GetUsersOptions,
  type ProviderOnlyField,
} from './FarcasterDataProvider';
import { HYPERSNAP_LACKS, NeynarDataProvider } from './NeynarDataProvider';
import { HubDataProvider } from './HubDataProvider';

export const DEFAULT_PROVIDER_ORDER = 'hypersnap,neynar,hub';

/** Copy one provider-only field between users without widening either type. */
function copyField<K extends ProviderOnlyField>(target: FarcasterUser, source: FarcasterUser, field: K): void {
  target[field] = source[field];
}

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
    const found = new Map<number, FarcasterUser>();
    /** FIDs whose answering provider lacks a needed field → fields still wanted. */
    const wanting = new Map<number, Set<ProviderOnlyField>>();
    const need = opts?.need ?? [];

    for (let i = 0; i < this.providers.length; i++) {
      const p = this.providers[i];
      const enrich = need.length
        ? Array.from(wanting.entries()).filter(([, f]) => Array.from(f).some(x => !p.lacks?.has(x))).map(([fid]) => fid)
        : [];
      if (remaining.length === 0 && enrich.length === 0) break;
      const ask = Array.from(new Set([...remaining, ...enrich]));
      if (ask.length === 0) continue;
      try {
        const users = await p.getUsers(ask, opts);
        for (const u of users) {
          const existing = found.get(u.fid);
          if (!existing) {
            found.set(u.fid, u);
            const missing = need.filter(f => p.lacks?.has(f));
            if (missing.length) wanting.set(u.fid, new Set(missing));
          } else {
            // Enrichment: copy only the fields the first answer lacked.
            const want = wanting.get(u.fid);
            if (!want) continue;
            for (const f of Array.from(want)) {
              if (p.lacks?.has(f)) continue;
              if (u[f] !== undefined) copyField(existing, u, f);
              want.delete(f);
            }
            if (want.size === 0) wanting.delete(u.fid);
          }
        }
        remaining = remaining.filter(f => !found.has(f));
      } catch (err) {
        console.warn(`[FarcasterData] ${p.name}.getUsers failed: ${(err as Error)?.message ?? err}`);
      }
    }
    return Array.from(found.values());
  }

  async getUser(fid: number, opts?: GetUsersOptions): Promise<FarcasterUser | null> {
    const users = await this.getUsers([fid], opts);
    return users.find(u => u.fid === fid) ?? null;
  }

  /** `pfp_url` for a FID, or null. The most common question the app asks. */
  async getAvatarUrl(fid: number): Promise<string | null> {
    return (await this.getUser(fid))?.pfp_url ?? null;
  }

  /**
   * Exact username lookup from the first capable provider. With `need`, fields
   * that provider lacks are enriched from the others (one extra lookup by FID).
   */
  async getUserByUsername(username: string, opts?: Pick<GetUsersOptions, 'need'>): Promise<FarcasterUser | null> {
    // `return await` (not bare `return`): workerd flags a promise that rejects
    // before the async wrapper adopts it as an unhandled rejection.
    const user = await this.first('getUserByUsername', p => p.getUserByUsername!(username), null);
    if (!user || !opts?.need?.length) return user;
    const answered = this.providers.find(p => p.name === user.provider);
    const missing = opts.need.filter(f => answered?.lacks?.has(f));
    if (missing.length === 0) return user;
    const enriched = await this.getUsers([user.fid], { need: missing });
    const extra = enriched.find(u => u.fid === user.fid);
    if (extra) for (const f of missing) if (extra[f] !== undefined) copyField(user, extra, f);
    return user;
  }

  /** Union of every provider's answer; throws only if all of them fail. */
  async getFidsByAddresses(addresses: string[]): Promise<number[]> {
    if (addresses.length === 0) return [];
    const capable = this.providers.filter(p => typeof p.getFidsByAddresses === 'function');
    if (capable.length === 0) throw new NoProviderError('getFidsByAddresses');
    const fids = new Set<number>();
    let ok = 0;
    let lastErr: unknown = null;
    for (const p of capable) {
      try {
        for (const f of await p.getFidsByAddresses!(addresses)) fids.add(f);
        ok++;
      } catch (err) {
        lastErr = err;
        console.warn(`[FarcasterData] ${p.name}.getFidsByAddresses failed: ${(err as Error)?.message ?? err}`);
      }
    }
    if (ok === 0) throw lastErr;
    return Array.from(fids).sort((a, b) => a - b);
  }

  async searchChannels(query: string, limit = 10): Promise<FarcasterChannel[]> {
    return await this.first('searchChannels', p => p.searchChannels!(query, limit), []);
  }

  async getBestFriends(fid: number, limit = 50): Promise<number[]> {
    return await this.first('getBestFriends', p => p.getBestFriends!(fid, limit));
  }

  /**
   * Follow edges between two FIDs. Protocol data (the hub's link messages)
   * beats Neynar's computed viewer_context, so the bare-hub provider is asked
   * first whatever the configured order; Neynar is the fallback.
   */
  async getRelationship(fid: number, targetFid: number): Promise<Relationship> {
    const hubFirst = [
      ...this.providers.filter(p => p.name === 'hub'),
      ...this.providers.filter(p => p.name !== 'hub'),
    ];
    return await this.first('getRelationship', p => p.getRelationship!(fid, targetFid), undefined, hubFirst);
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
    providers: FarcasterDataProvider[] = this.providers,
  ): Promise<T> {
    let lastErr: unknown = null;
    let tried = 0;
    for (const p of providers) {
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
 * `hypersnap` / `neynar` / `hub`), default `hypersnap,neynar,hub`.
 *   hypersnap — Neynar-compatible `/v2/farcaster` API at `HYPERSNAP_ENDPOINT`
 *               (falls back to `HUB_ENDPOINT`), keyless. Haatz today, own node later.
 *   neynar    — `api.neynar.com` with `NEYNAR_API_KEY`.
 *   hub       — bare hub `/v1/*` API at `HUB_ENDPOINT` (profiles only).
 * A provider whose config is missing is skipped. Throws when nothing is
 * configured — every deployment must be able to resolve a FID to a profile.
 */
export function initFarcasterData(env: Env, opts: InitFarcasterDataOptions = {}): FarcasterDataRouter {
  const order = String(env?.FC_DATA_PROVIDER_ORDER ?? DEFAULT_PROVIDER_ORDER)
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
  const providers: FarcasterDataProvider[] = [];
  for (const name of order) {
    if (name === 'hypersnap') {
      const endpoint: string | undefined = env?.HYPERSNAP_ENDPOINT ?? env?.HUB_ENDPOINT;
      if (endpoint) {
        providers.push(new NeynarDataProvider({
          name: 'hypersnap',
          baseUrl: `${String(endpoint).replace(/\/$/, '')}/v2/farcaster`,
          lacks: HYPERSNAP_LACKS,
          fetchImpl: opts.fetchImpl,
        }));
      }
    } else if (name === 'neynar') {
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
    throw new Error('No Farcaster data providers configured. Set HYPERSNAP_ENDPOINT / HUB_ENDPOINT and/or NEYNAR_API_KEY.');
  }
  return new FarcasterDataRouter(providers);
}
