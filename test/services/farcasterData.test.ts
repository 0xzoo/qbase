/**
 * farcaster/ — data providers + router (Track C1 / C1b).
 *
 * Providers take an injected fetch, so every test runs against canned wire
 * payloads: the Neynar-compatible REST shapes (Neynar and Hypersnap/Haatz)
 * and the hub's message envelopes. The router tests pin the fill-in-order
 * semantics (later providers answer only the FIDs earlier ones missed),
 * `need` enrichment of provider-only fields, the address→FID union, and
 * capability skipping.
 *
 * Eagerly-rejected promises are consumed with `.catch(e => e)` rather than
 * `expect(...).rejects`: the workers pool flags the latter as unhandled.
 */

import { describe, it, expect } from 'vitest';
import { HYPERSNAP_LACKS, NEYNAR_BASE, NeynarDataProvider, NeynarError } from '../../worker/services/farcaster/NeynarDataProvider';
import { HubDataProvider } from '../../worker/services/farcaster/HubDataProvider';
import { DEFAULT_PROVIDER_ORDER, FarcasterDataRouter, initFarcasterData } from '../../worker/services/farcaster/FarcasterDataRouter';
import {
  NoProviderError,
  type FarcasterDataProvider,
  type FarcasterUser,
  type ProviderOnlyField,
} from '../../worker/services/farcaster/FarcasterDataProvider';

type Route = (url: URL, init?: RequestInit) => Response | Promise<Response>;

/** Fake fetch: first matching substring route wins; records every call. */
function fakeFetch(routes: Array<[string, Route]>) {
  const calls: Array<{ url: URL; headers: Record<string, string> }> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const headers = Object.fromEntries(new Headers(init?.headers ?? {}).entries());
    calls.push({ url, headers });
    for (const [needle, route] of routes) {
      if (url.href.includes(needle)) return route(url, init);
    }
    return new Response(JSON.stringify({ error: 'unrouted' }), { status: 404 });
  }) as typeof fetch;
  return { impl, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const neynarUser = (fid: number, extra: Record<string, unknown> = {}) => ({
  object: 'user', fid, username: `u${fid}`, display_name: `User ${fid}`, pfp_url: `https://pfp/${fid}`,
  custody_address: '0x' + fid.toString(16).padStart(40, '0'), profile: { bio: { text: `bio ${fid}` } },
  follower_count: fid * 10, following_count: fid, verified_addresses: { eth_addresses: [`0xeth${fid}`], primary: { eth_address: `0xeth${fid}` } },
  score: 0.5, ...extra,
});

/** Haatz never returns the proprietary fields. */
const hypersnapUser = (fid: number) => {
  const { score: _s, ...u } = neynarUser(fid); // eslint-disable-line @typescript-eslint/no-unused-vars
  return u;
};

const hubUserData = (fid: number, fields: Record<string, string>) => ({
  messages: Object.entries(fields).map(([type, value]) => ({ data: { type: 'MESSAGE_TYPE_USER_DATA_ADD', fid, userDataBody: { type, value } } })),
});

describe('NeynarDataProvider (Neynar)', () => {
  it('getUsers batches at 100 FIDs, forwards viewer_fid, sends the key, and maps the wire shape', async () => {
    const { impl, calls } = fakeFetch([
      ['/user/bulk?', (url) => {
        const fids = url.searchParams.get('fids')!.split(',').map(Number);
        return json({ users: fids.map(f => neynarUser(f, { viewer_context: { following: true, followed_by: false }, pro: { status: 'subscribed', expires_at: '2027-01-01' }, power_badge: true })) });
      }],
    ]);
    const p = new NeynarDataProvider({ apiKey: 'k', fetchImpl: impl });
    const fids = Array.from({ length: 150 }, (_, i) => i + 1);
    const users = await p.getUsers(fids, { viewerFid: 999 });

    expect(calls).toHaveLength(2);
    expect(calls[0].url.href.startsWith(NEYNAR_BASE)).toBe(true);
    expect(calls[0].headers['x-api-key']).toBe('k');
    expect(calls[0].url.searchParams.get('fids')!.split(',')).toHaveLength(100);
    expect(calls[1].url.searchParams.get('fids')!.split(',')).toHaveLength(50);
    expect(calls[0].url.searchParams.get('viewer_fid')).toBe('999');
    expect(users).toHaveLength(150);
    expect(users.find(x => x.fid === 7)).toMatchObject({
      fid: 7, username: 'u7', display_name: 'User 7', pfp_url: 'https://pfp/7', score: 0.5, provider: 'neynar', power_badge: true,
      pro: { status: 'subscribed' }, viewer_context: { following: true, followed_by: false },
      profile: { bio: { text: 'bio 7' } }, verified_addresses: { primary: { eth_address: '0xeth7' } },
    });
    expect(p.lacks).toBeUndefined();
  });

  it('dedupes and ignores invalid FIDs', async () => {
    const { impl, calls } = fakeFetch([['/user/bulk?', (url) => json({ users: url.searchParams.get('fids')!.split(',').map(f => neynarUser(Number(f))) })]]);
    const p = new NeynarDataProvider({ apiKey: 'secret', fetchImpl: impl });
    expect((await p.getUsers([3, 3, 0, -1, 4.5, 5])).map(u => u.fid)).toEqual([3, 5]);
    expect(calls).toHaveLength(1);
  });

  it('getFidsByAddresses batches at 350, lowercases, dedupes and sorts', async () => {
    const { impl, calls } = fakeFetch([
      ['/user/bulk-by-address?', (url) => {
        const addrs = url.searchParams.get('addresses')!.split(',');
        const out: Record<string, Array<{ fid: number }>> = {};
        addrs.forEach((a, i) => { out[a] = [{ fid: 1000 - (i % 5) }]; }); // collisions → dedupe
        return json(out);
      }],
    ]);
    const p = new NeynarDataProvider({ apiKey: 'k', fetchImpl: impl });
    const addrs = Array.from({ length: 351 }, (_, i) => '0xABC' + i.toString().padStart(37, '0'));
    const fids = await p.getFidsByAddresses([...addrs, addrs[0].toLowerCase()]);
    expect(calls).toHaveLength(2);
    expect(calls[0].url.searchParams.get('addresses')!.split(',')).toHaveLength(350);
    expect(calls[0].url.searchParams.get('addresses')).toBe(calls[0].url.searchParams.get('addresses')!.toLowerCase());
    expect(fids).toEqual([996, 997, 998, 999, 1000]);
  });

  it('getUserByUsername maps 404 to null and other errors to NeynarError', async () => {
    const { impl } = fakeFetch([
      ['username=ghost', () => json({ code: 'NotFound' }, 404)],
      ['username=boom', () => new Response('nope', { status: 500 })],
      ['/user/by_username?', () => json({ user: neynarUser(42) })],
    ]);
    const p = new NeynarDataProvider({ apiKey: 'k', fetchImpl: impl });
    expect(await p.getUserByUsername('ghost')).toBeNull();
    expect(await p.getUserByUsername('boom').catch(e => e)).toBeInstanceOf(NeynarError);
    expect((await p.getUserByUsername('dwr'))?.fid).toBe(42);
  });

  it('searchChannels clamps limit and getBestFriends returns FIDs', async () => {
    const { impl, calls } = fakeFetch([
      ['/channel/search?', () => json({ channels: [{ id: 'q', url: 'https://c/q', name: 'q' }] })],
      ['/user/best_friends?', () => json({ users: [{ fid: 1 }, { fid: 2 }] })],
    ]);
    const p = new NeynarDataProvider({ apiKey: 'k', fetchImpl: impl });
    expect(await p.searchChannels('q', 500)).toEqual([{ id: 'q', url: 'https://c/q', name: 'q' }]);
    expect(calls[0].url.searchParams.get('limit')).toBe('20');
    expect(await p.getBestFriends(9, 500)).toEqual([1, 2]);
    expect(calls[1].url.searchParams.get('limit')).toBe('50');
  });

  it('refuses api.neynar.com without a key', () => {
    expect(() => new NeynarDataProvider({})).toThrow(/apiKey is required/);
  });
});

describe('NeynarDataProvider (Hypersnap / Haatz mode)', () => {
  it('hits the hub base URL keyless, stamps provider=hypersnap, declares what it lacks', async () => {
    const { impl, calls } = fakeFetch([['/v2/farcaster/user/bulk?', () => json({ users: [hypersnapUser(3)] })]]);
    const p = new NeynarDataProvider({ name: 'hypersnap', baseUrl: 'https://haatz.example/v2/farcaster/', lacks: HYPERSNAP_LACKS, fetchImpl: impl });
    const [u] = await p.getUsers([3]);
    expect(calls[0].url.href).toBe('https://haatz.example/v2/farcaster/user/bulk?fids=3');
    expect(calls[0].headers['x-api-key']).toBeUndefined();
    expect(u).toMatchObject({ fid: 3, provider: 'hypersnap', username: 'u3', follower_count: 30 });
    expect(u.score).toBeUndefined();
    expect(p.lacks?.has('pro')).toBe(true);
  });
});

describe('HubDataProvider', () => {
  it('assembles a user from userDataByFid + verificationsByFid', async () => {
    const { impl } = fakeFetch([
      ['/v1/userDataByFid?fid=3', () => json(hubUserData(3, {
        USER_DATA_TYPE_USERNAME: 'dwr', USER_DATA_TYPE_DISPLAY: 'Dan Romero', USER_DATA_TYPE_PFP: 'https://pfp/dwr',
        USER_DATA_TYPE_BIO: 'Interested in technology', USER_DATA_PRIMARY_ADDRESS_ETHEREUM: '0x6Ce0', USER_DATA_TYPE_LOCATION: '',
      }))],
      ['/v1/verificationsByFid?fid=3', () => json({ messages: [
        { data: { type: 'MESSAGE_TYPE_VERIFICATION_ADD_ETH_ADDRESS', fid: 3, verificationAddAddressBody: { address: '0x187c', protocol: 'PROTOCOL_ETHEREUM' } } },
        { data: { type: 'MESSAGE_TYPE_VERIFICATION_ADD_ETH_ADDRESS', fid: 3, verificationAddAddressBody: { address: 'ExAqci', protocol: 'PROTOCOL_SOLANA' } } },
      ] })],
    ]);
    const p = new HubDataProvider({ hubEndpoint: 'https://hub.example/', fetchImpl: impl });
    const [u] = await p.getUsers([3]);
    expect(u).toEqual({
      fid: 3, provider: 'hub', username: 'dwr', display_name: 'Dan Romero', pfp_url: 'https://pfp/dwr',
      profile: { bio: { text: 'Interested in technology' } },
      verified_addresses: { primary: { eth_address: '0x6Ce0' }, eth_addresses: ['0x187c'], sol_addresses: ['ExAqci'] },
    });
    expect(u.score).toBeUndefined();
  });

  it('omits FIDs the hub does not know and surfaces 5xx as errors', async () => {
    const { impl } = fakeFetch([
      ['fid=404', () => json({ errCode: 'not_found', details: 'no data' }, 400)],
      ['fid=500', () => new Response('boom', { status: 500 })],
      ['/v1/userDataByFid?fid=1', () => json(hubUserData(1, { USER_DATA_TYPE_USERNAME: 'one' }))],
      ['/v1/verificationsByFid?fid=1', () => json({ messages: [] })],
    ]);
    const p = new HubDataProvider({ hubEndpoint: 'https://hub.example', fetchImpl: impl });
    expect((await p.getUsers([1, 404])).map(u => u.fid)).toEqual([1]);
    expect(String(await p.getUsers([500]).catch(e => e))).toMatch(/Hub 500/);
  });

  it('getUserByUsername resolves through userNameProofByName', async () => {
    const { impl } = fakeFetch([
      ['/v1/userNameProofByName?name=dwr', () => json({ fid: 3, name: 'dwr' })],
      ['/v1/userNameProofByName?name=nobody', () => json({ errCode: 'not_found' }, 400)],
      ['/v1/userDataByFid?fid=3', () => json(hubUserData(3, { USER_DATA_TYPE_USERNAME: 'dwr' }))],
      ['/v1/verificationsByFid', () => json({ messages: [] })],
    ]);
    const p = new HubDataProvider({ hubEndpoint: 'https://hub.example', fetchImpl: impl });
    expect((await p.getUserByUsername('dwr'))?.fid).toBe(3);
    expect(await p.getUserByUsername('nobody')).toBeNull();
  });
});

/** Minimal in-memory provider for router tests. */
function stubProvider(name: string, users: Record<number, Partial<FarcasterUser>>, opts: {
  throws?: boolean;
  lacks?: ProviderOnlyField[];
  caps?: Partial<Pick<FarcasterDataProvider, 'getFidsByAddresses' | 'searchChannels' | 'getBestFriends' | 'getUserByUsername'>>;
} = {}): FarcasterDataProvider & { calls: number[][] } {
  const calls: number[][] = [];
  return {
    name,
    calls,
    lacks: opts.lacks ? new Set(opts.lacks) : undefined,
    async getUsers(fids) {
      calls.push([...fids]);
      if (opts.throws) throw new Error(`${name} down`);
      return fids.filter(f => users[f]).map(f => ({ fid: f, provider: name, ...users[f] }));
    },
    ...opts.caps,
  };
}

const LACKS: ProviderOnlyField[] = ['score', 'pro', 'power_badge', 'viewer_context'];

describe('FarcasterDataRouter', () => {
  it('later providers fill only the FIDs earlier ones missed', async () => {
    const neynar = stubProvider('neynar', { 1: { username: 'a', score: 0.9 }, 2: { username: 'b' } });
    const hub = stubProvider('hub', { 2: { username: 'b-hub' }, 3: { username: 'c' } });
    const r = new FarcasterDataRouter([neynar, hub]);
    const users = await r.getUsers([1, 2, 3, 4]);
    expect(users.map(u => [u.fid, u.provider])).toEqual([[1, 'neynar'], [2, 'neynar'], [3, 'hub']]);
    expect(hub.calls).toEqual([[3, 4]]);
    expect(await r.getUser(4)).toBeNull();
  });

  it('a throwing provider is skipped, not fatal', async () => {
    const neynar = stubProvider('neynar', { 1: { username: 'a' } }, { throws: true });
    const hub = stubProvider('hub', { 1: { username: 'a-hub', pfp_url: 'https://p/1' } });
    const r = new FarcasterDataRouter([neynar, hub]);
    expect((await r.getUser(1))?.provider).toBe('hub');
    expect(await r.getAvatarUrl(1)).toBe('https://p/1');
    expect(await r.getAvatarUrl(2)).toBeNull();
  });

  it('`need` enriches provider-only fields from a later provider; without it nobody is asked twice', async () => {
    const hypersnap = stubProvider('hypersnap', { 1: { username: 'a', follower_count: 10 }, 2: { username: 'b' } }, { lacks: LACKS });
    const neynar = stubProvider('neynar', { 1: { username: 'a-neynar', pro: { status: 'subscribed' }, score: 0.7 }, 3: { username: 'c' } });
    const r = new FarcasterDataRouter([hypersnap, neynar]);

    const plain = await r.getUsers([1, 2]);
    expect(plain.map(u => u.provider)).toEqual(['hypersnap', 'hypersnap']);
    expect(neynar.calls).toEqual([]);                       // nothing missing, Neynar never asked

    const users = await r.getUsers([1, 2, 3], { need: ['pro'] });
    expect(neynar.calls).toEqual([[3, 1, 2]]);              // the missed FID plus the two to enrich
    const u1 = users.find(u => u.fid === 1)!;
    expect(u1).toMatchObject({ provider: 'hypersnap', username: 'a', follower_count: 10, pro: { status: 'subscribed' } });
    expect(u1.score).toBeUndefined();                       // only the needed field is merged
    expect(users.find(u => u.fid === 2)?.pro).toBeUndefined(); // Neynar had no pro for 2 → stays undefined
    expect(users.find(u => u.fid === 3)?.provider).toBe('neynar');
  });

  it('getUserByUsername enriches `need` fields the answering provider lacks', async () => {
    const hypersnap = stubProvider('hypersnap', { 5: { username: 'e' } }, {
      lacks: LACKS, caps: { getUserByUsername: async () => ({ fid: 5, provider: 'hypersnap', username: 'e' }) },
    });
    const neynar = stubProvider('neynar', { 5: { username: 'e', power_badge: true } });
    const r = new FarcasterDataRouter([hypersnap, neynar]);
    expect(await r.getUserByUsername('e')).toEqual({ fid: 5, provider: 'hypersnap', username: 'e' });
    expect(neynar.calls).toEqual([]);
    expect(await r.getUserByUsername('e', { need: ['power_badge'] })).toMatchObject({ provider: 'hypersnap', power_badge: true });
    expect(neynar.calls).toEqual([[5]]);
  });

  it('getFidsByAddresses is the union over capable providers and tolerates one failing', async () => {
    const hypersnap = stubProvider('hypersnap', {}, { caps: { getFidsByAddresses: async () => [1, 2] } });
    const neynar = stubProvider('neynar', {}, { caps: { getFidsByAddresses: async () => [2, 3] } });
    const broken = stubProvider('broken', {}, { caps: { getFidsByAddresses: async () => { throw new Error('down'); } } });
    const hub = stubProvider('hub', {});
    expect(await new FarcasterDataRouter([hypersnap, broken, neynar, hub]).getFidsByAddresses(['0xa'])).toEqual([1, 2, 3]);
    expect(await new FarcasterDataRouter([hypersnap]).getFidsByAddresses([])).toEqual([]);
    expect(String(await new FarcasterDataRouter([broken]).getFidsByAddresses(['0xa']).catch(e => e))).toMatch(/down/);
    expect(await new FarcasterDataRouter([hub]).getFidsByAddresses(['0xa']).catch(e => e)).toBeInstanceOf(NoProviderError);
  });

  it('other capabilities skip providers that lack them and fall through on failure', async () => {
    const hub = stubProvider('hub', {});
    const neynar = stubProvider('neynar', {}, { caps: {
      searchChannels: async () => { throw new Error('search down'); },
    } });
    const r = new FarcasterDataRouter([hub, neynar]);
    expect(await r.searchChannels('x')).toEqual([]);          // fallback when every provider fails
    expect(await r.getUserByUsername('x')).toBeNull();        // nobody implements it → fallback
    expect(await r.getBestFriends(1).catch(e => e)).toBeInstanceOf(NoProviderError);
  });
});

describe('initFarcasterData', () => {
  const env = { NEYNAR_API_KEY: 'k', HUB_ENDPOINT: 'https://h', HYPERSNAP_ENDPOINT: 'https://hs' };

  it('defaults to hypersnap,neynar,hub and honours FC_DATA_PROVIDER_ORDER', () => {
    expect(DEFAULT_PROVIDER_ORDER).toBe('hypersnap,neynar,hub');
    expect(initFarcasterData(env).listProviders()).toEqual(['hypersnap', 'neynar', 'hub']);
    expect(initFarcasterData({ ...env, FC_DATA_PROVIDER_ORDER: 'neynar, hub' }).listProviders()).toEqual(['neynar', 'hub']);
    expect(initFarcasterData({ HUB_ENDPOINT: 'https://h' }).listProviders()).toEqual(['hypersnap', 'hub']); // HUB_ENDPOINT also serves /v2
    expect(initFarcasterData({ NEYNAR_API_KEY: 'k' }).listProviders()).toEqual(['neynar']);
    expect(initFarcasterData({ NEYNAR_API_KEY: 'k', FC_DATA_PROVIDER_ORDER: 'neynar,bogus' }).listProviders()).toEqual(['neynar']);
  });

  it('points the hypersnap provider at <HYPERSNAP_ENDPOINT>/v2/farcaster, keyless', async () => {
    const { impl, calls } = fakeFetch([['/user/bulk?', () => json({ users: [hypersnapUser(1)] })]]);
    const r = initFarcasterData({ ...env, FC_DATA_PROVIDER_ORDER: 'hypersnap' }, { fetchImpl: impl });
    expect((await r.getUser(1))?.provider).toBe('hypersnap');
    expect(calls[0].url.href).toBe('https://hs/v2/farcaster/user/bulk?fids=1');
    expect(calls[0].headers['x-api-key']).toBeUndefined();
  });

  it('honours a per-call Neynar key override (Q agent key)', async () => {
    const { impl, calls } = fakeFetch([['/user/bulk?', () => json({ users: [neynarUser(1)] })]]);
    const r = initFarcasterData({ NEYNAR_API_KEY: 'app' }, { neynarApiKey: 'q-key', fetchImpl: impl });
    await r.getUser(1);
    expect(calls[0].headers['x-api-key']).toBe('q-key');
  });

  it('throws when nothing is configured', () => {
    expect(() => initFarcasterData({})).toThrow(/No Farcaster data providers/);
  });
});

describe('getRelationship (Track C card C10)', () => {
  const linkOk = (fid: number, target: number) => json({
    data: { type: 'MESSAGE_TYPE_LINK_ADD', fid, linkBody: { type: 'follow', targetFid: target } }, hash: '0x64f4',
  });
  const linkMissing = () => json({ error: 'Failed to get link', error_detail: 'status: NotFound' }, 400);

  it('HubDataProvider reads both directions from /v1/linkById; a missing edge is false', async () => {
    const { impl, calls } = fakeFetch([
      ['/v1/linkById?fid=975961&target_fid=3&link_type=follow', () => linkOk(975961, 3)],
      ['/v1/linkById?fid=3&target_fid=975961&link_type=follow', linkMissing],
    ]);
    const p = new HubDataProvider({ hubEndpoint: 'https://hub.example', fetchImpl: impl });
    expect(await p.getRelationship(975961, 3)).toEqual({ following: true, followed_by: false });
    expect(calls.map(c => c.url.pathname + c.url.search).sort()).toEqual([
      '/v1/linkById?fid=3&target_fid=975961&link_type=follow',
      '/v1/linkById?fid=975961&target_fid=3&link_type=follow',
    ]);
  });

  it('NeynarDataProvider maps viewer_context; the Hypersnap instance has no getRelationship', async () => {
    const { impl, calls } = fakeFetch([
      ['/user/bulk?fids=3&viewer_fid=975961', () => json({ users: [neynarUser(3, { viewer_context: { following: true, followed_by: true } })] })],
    ]);
    const neynar = new NeynarDataProvider({ apiKey: 'k', fetchImpl: impl });
    expect(await neynar.getRelationship!(975961, 3)).toEqual({ following: true, followed_by: true });
    expect(calls[0].url.pathname).toBe('/v2/farcaster/user/bulk');

    const hypersnap = new NeynarDataProvider({ name: 'hypersnap', baseUrl: 'https://haatz.example/v2/farcaster', lacks: HYPERSNAP_LACKS, fetchImpl: impl });
    expect(hypersnap.getRelationship).toBeUndefined();
  });

  it('the router asks the hub before Neynar whatever the configured order, and falls back', async () => {
    const asked: string[] = [];
    const mk = (name: string, answer: FarcasterUser['viewer_context'] | Error): FarcasterDataProvider => ({
      name,
      getUsers: async () => [],
      getRelationship: async () => {
        asked.push(name);
        if (answer instanceof Error) throw answer;
        return { following: !!answer?.following, followed_by: !!answer?.followed_by };
      },
    });
    const hypersnap: FarcasterDataProvider = { name: 'hypersnap', getUsers: async () => [] };

    const r1 = await new FarcasterDataRouter([hypersnap, mk('neynar', { following: false, followed_by: true }), mk('hub', { following: true, followed_by: false })])
      .getRelationship(1, 2);
    expect(r1).toEqual({ following: true, followed_by: false });
    expect(asked).toEqual(['hub']);

    asked.length = 0;
    const r2 = await new FarcasterDataRouter([mk('neynar', { following: false, followed_by: true }), mk('hub', new Error('hub down'))])
      .getRelationship(1, 2);
    expect(r2).toEqual({ following: false, followed_by: true });
    expect(asked).toEqual(['hub', 'neynar']);

    const err = await new FarcasterDataRouter([hypersnap]).getRelationship(1, 2).catch(e => e);
    expect(err).toBeInstanceOf(NoProviderError);
  });
});
