/**
 * farcaster/ — data providers + router (Track C1).
 *
 * Providers take an injected fetch, so every test runs against canned wire
 * payloads: Neynar's REST shapes and the hub's message envelopes. The router
 * tests pin the fill-in-order semantics (later providers answer only the FIDs
 * earlier ones missed) and capability skipping.
 */

import { describe, it, expect } from 'vitest';
import { NeynarDataProvider, NeynarError } from '../../worker/services/farcaster/NeynarDataProvider';
import { HubDataProvider } from '../../worker/services/farcaster/HubDataProvider';
import { FarcasterDataRouter, initFarcasterData } from '../../worker/services/farcaster/FarcasterDataRouter';
import { NoProviderError, type FarcasterDataProvider, type FarcasterUser } from '../../worker/services/farcaster/FarcasterDataProvider';

type Route = (url: URL, init?: RequestInit) => Response | Promise<Response>;

/** Fake fetch: first matching substring route wins; records every call. */
function fakeFetch(routes: Array<[string, Route]>) {
  const calls: URL[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    calls.push(url);
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

const hubUserData = (fid: number, fields: Record<string, string>) => ({
  messages: Object.entries(fields).map(([type, value]) => ({ data: { type: 'MESSAGE_TYPE_USER_DATA_ADD', fid, userDataBody: { type, value } } })),
});

describe('NeynarDataProvider', () => {
  it('getUsers batches at 100 FIDs, forwards viewer_fid, and maps the wire shape', async () => {
    const { impl, calls } = fakeFetch([
      ['/user/bulk?', (url) => {
        const fids = url.searchParams.get('fids')!.split(',').map(Number);
        return json({ users: fids.map(f => neynarUser(f, { viewer_context: { following: true, followed_by: false }, pro: { status: 'subscribed', expires_at: '2027-01-01' } })) });
      }],
    ]);
    const p = new NeynarDataProvider({ apiKey: 'k', fetchImpl: impl });
    const fids = Array.from({ length: 150 }, (_, i) => i + 1);
    const users = await p.getUsers(fids, { viewerFid: 999 });

    expect(calls).toHaveLength(2);
    expect(calls[0].searchParams.get('fids')!.split(',')).toHaveLength(100);
    expect(calls[1].searchParams.get('fids')!.split(',')).toHaveLength(50);
    expect(calls[0].searchParams.get('viewer_fid')).toBe('999');
    expect(users).toHaveLength(150);
    const u = users.find(x => x.fid === 7)!;
    expect(u).toMatchObject({
      fid: 7, username: 'u7', display_name: 'User 7', pfp_url: 'https://pfp/7', score: 0.5, provider: 'neynar',
      pro: { status: 'subscribed' }, viewer_context: { following: true, followed_by: false },
      profile: { bio: { text: 'bio 7' } }, verified_addresses: { primary: { eth_address: '0xeth7' } },
    });
  });

  it('getUsers sends the API key header and dedupes/ignores invalid FIDs', async () => {
    const { impl, calls } = fakeFetch([['/user/bulk?', (url) => json({ users: url.searchParams.get('fids')!.split(',').map(f => neynarUser(Number(f))) })]]);
    const p = new NeynarDataProvider({ apiKey: 'secret', fetchImpl: impl });
    const users = await p.getUsers([3, 3, 0, -1, 4.5, 5]);
    expect(users.map(u => u.fid)).toEqual([3, 5]);
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
    expect(calls[0].searchParams.get('addresses')!.split(',')).toHaveLength(350);
    expect(calls[0].searchParams.get('addresses')).toBe(calls[0].searchParams.get('addresses')!.toLowerCase());
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
    expect(calls[0].searchParams.get('limit')).toBe('20');
    expect(await p.getBestFriends(9, 500)).toEqual([1, 2]);
    expect(calls[1].searchParams.get('limit')).toBe('50');
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
  caps?: Partial<Pick<FarcasterDataProvider, 'getFidsByAddresses' | 'searchChannels' | 'getBestFriends' | 'getUserByUsername'>>;
} = {}): FarcasterDataProvider & { calls: number[][] } {
  const calls: number[][] = [];
  return {
    name,
    calls,
    async getUsers(fids) {
      calls.push([...fids]);
      if (opts.throws) throw new Error(`${name} down`);
      return fids.filter(f => users[f]).map(f => ({ fid: f, provider: name, ...users[f] }));
    },
    ...opts.caps,
  };
}

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

  it('capabilities skip providers that lack them and fall through on failure', async () => {
    const hub = stubProvider('hub', {});
    const neynar = stubProvider('neynar', {}, { caps: {
      getFidsByAddresses: async (addrs) => addrs.map((_, i) => i + 1),
      searchChannels: async () => { throw new Error('search down'); },
    } });
    const r = new FarcasterDataRouter([hub, neynar]);
    expect(await r.getFidsByAddresses(['0xa', '0xb'])).toEqual([1, 2]);
    expect(await r.getFidsByAddresses([])).toEqual([]);
    expect(await r.searchChannels('x')).toEqual([]);          // fallback when every provider fails
    expect(await r.getUserByUsername('x')).toBeNull();        // nobody implements it → fallback
    // .catch attached synchronously: the workers pool flags an eagerly-rejected promise as unhandled otherwise.
    expect(await new FarcasterDataRouter([hub]).getFidsByAddresses(['0xa']).catch(e => e)).toBeInstanceOf(NoProviderError);
    expect(await r.getBestFriends(1).catch(e => e)).toBeInstanceOf(NoProviderError);
  });
});

describe('initFarcasterData', () => {
  it('builds providers in FC_DATA_PROVIDER_ORDER, skipping unconfigured ones', () => {
    expect(initFarcasterData({ NEYNAR_API_KEY: 'k', HUB_ENDPOINT: 'https://h' }).listProviders()).toEqual(['neynar', 'hub']);
    expect(initFarcasterData({ NEYNAR_API_KEY: 'k', HUB_ENDPOINT: 'https://h', FC_DATA_PROVIDER_ORDER: 'hub, neynar' }).listProviders()).toEqual(['hub', 'neynar']);
    expect(initFarcasterData({ HUB_ENDPOINT: 'https://h' }).listProviders()).toEqual(['hub']);
    expect(initFarcasterData({ NEYNAR_API_KEY: 'k', FC_DATA_PROVIDER_ORDER: 'neynar,bogus' }).listProviders()).toEqual(['neynar']);
  });

  it('honours a per-call Neynar key override (Q agent key)', async () => {
    const { impl, calls } = fakeFetch([['/user/bulk?', () => json({ users: [neynarUser(1)] })]]);
    const r = initFarcasterData({ NEYNAR_API_KEY: 'app' }, { neynarApiKey: 'q-key', fetchImpl: impl });
    await r.getUser(1);
    expect(calls).toHaveLength(1);
  });

  it('throws when nothing is configured', () => {
    expect(() => initFarcasterData({})).toThrow(/No Farcaster data providers/);
  });
});
