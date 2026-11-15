/**
 * Fork hardening (R1): node failover, FID parsing, signer checks.
 *
 * After the Hypersnap validator fork (2026-11-13) qbase reads and writes
 * through its own node with Haatz as the second, native accounts have FIDs
 * from 2^32 that arrive as decimal strings, and a signer may be a gasless key
 * the OP KeyRegistry has never seen. Wire shapes below are the ones hs1
 * returned on 2026-11-15.
 *
 * Rejections are consumed with `.catch(e => e)`: the workers pool flags
 * `expect(...).rejects` on an eagerly rejected promise as unhandled.
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  failoverFetch,
  hypersnapFallbacks,
  hypersnapPrimaries,
  resetHypersnapFailover,
} from '../../worker/services/hypersnapFailover';
import { isNativeFid, parseFid } from '../../worker/services/farcaster/fid';
import { HYPERSNAP_LACKS, NeynarDataProvider } from '../../worker/services/farcaster/NeynarDataProvider';
import { FarcasterDataRouter, initFarcasterData } from '../../worker/services/farcaster/FarcasterDataRouter';
import { HypersnapError, HypersnapService, createHypersnapService, messageHashHex } from '../../worker/services/HypersnapService';
import { isFidSigner } from '../../worker/routes/webhooks';

const HS1 = 'https://hs1.test';
const HAATZ = 'https://haatz.test';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response>;

function fakeFetch(handler: Handler) {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return { impl, calls };
}

beforeEach(() => resetHypersnapFailover());
afterEach(() => vi.restoreAllMocks());

describe('parseFid', () => {
  it('accepts legacy numbers and native decimal strings', () => {
    expect(parseFid(3321680)).toBe(3321680);
    expect(parseFid('3321680')).toBe(3321680);
    expect(parseFid('4294967296')).toBe(4294967296);
    expect(parseFid(4294967296)).toBe(4294967296);
  });

  it('refuses what is not a FID', () => {
    for (const bad of [0, -1, 1.5, NaN, Infinity, '', '0', '007', '-5', '1e9', '0x10', ' 12', '12 ', null, undefined, {}, [], true]) {
      expect(parseFid(bad), String(bad)).toBeNull();
    }
  });

  it('refuses anything in the account-id range (>= 2^40), number or string', () => {
    expect(parseFid(2 ** 40 - 1)).toBe(2 ** 40 - 1);
    expect(parseFid(2 ** 40)).toBeNull();
    expect(parseFid(String(2 ** 40))).toBeNull();
    expect(parseFid('9007199254740993')).toBeNull(); // past 2^53: would lose precision
    expect(parseFid('99999999999999999999')).toBeNull();
  });

  it('tells native accounts from legacy ones', () => {
    expect(isNativeFid(4294967295)).toBe(false);
    expect(isNativeFid(4294967296)).toBe(true);
  });
});

describe('endpoint lists', () => {
  it('reads primaries and fallbacks from env, trimmed and de-duplicated', () => {
    const env = {
      HYPERSNAP_ENDPOINT: `${HS1}/`,
      HUB_ENDPOINT: HS1,
      HYPERSNAP_FALLBACK_ENDPOINTS: ` ${HAATZ}/ , ${HS1}, ${HAATZ},`,
    };
    expect(hypersnapPrimaries(env)).toEqual([HS1]);
    expect(hypersnapFallbacks(env)).toEqual([HAATZ]);
    expect(hypersnapFallbacks({ HYPERSNAP_ENDPOINT: HS1 })).toEqual([]);
  });
});

describe('failoverFetch', () => {
  const make = (handler: Handler, clock = { t: 1_000_000 }) => {
    const f = fakeFetch(handler);
    const fetchImpl = failoverFetch({ primaries: [HS1], fallbacks: [HAATZ], fetchImpl: f.impl, now: () => clock.t });
    return { ...f, fetchImpl, clock };
  };

  it('serves from the primary and never touches the fallback when it is healthy', async () => {
    const { fetchImpl, calls } = make(() => json({ ok: 1 }));
    const res = await fetchImpl(`${HS1}/v1/info`);
    expect(res.status).toBe(200);
    expect(calls.map(c => c.url.origin)).toEqual([HS1]);
  });

  it('replays a read on the fallback, same path and query, when the primary answers 5xx', async () => {
    const { fetchImpl, calls } = make(url => (url.origin === HS1 ? new Response('down', { status: 503 }) : json({ from: 'haatz' })));
    const res = await fetchImpl(`${HS1}/v2/farcaster/user/bulk?fids=1,2`);
    expect(await res.json()).toEqual({ from: 'haatz' });
    expect(calls.map(c => c.url.href)).toEqual([
      `${HS1}/v2/farcaster/user/bulk?fids=1,2`,
      `${HAATZ}/v2/farcaster/user/bulk?fids=1,2`,
    ]);
  });

  it('replays when the primary throws (DNS, TLS, timeout)', async () => {
    const { fetchImpl, calls } = make(url => {
      if (url.origin === HS1) throw new TypeError('connection refused');
      return json({ from: 'haatz' });
    });
    const res = await fetchImpl(`${HS1}/v1/info`);
    expect(await res.json()).toEqual({ from: 'haatz' });
    expect(calls).toHaveLength(2);
  });

  it('does not fail over on a 4xx: that is the node answering', async () => {
    const { fetchImpl, calls } = make(() => new Response('{"error":"not found"}', { status: 404 }));
    const res = await fetchImpl(`${HS1}/v2/farcaster/cast?identifier=0xabc&type=hash`);
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(1);
  });

  it('a write fails over on a gateway status and carries the same body', async () => {
    const body = new Uint8Array([1, 2, 3]);
    const { fetchImpl, calls } = make(url => (url.origin === HS1 ? new Response('bad gateway', { status: 502 }) : json({ hash: '0xabc' })));
    const res = await fetchImpl(`${HS1}/v1/submitMessage`, { method: 'POST', body });
    expect(await res.json()).toEqual({ hash: '0xabc' });
    expect(calls).toHaveLength(2);
    expect(calls[1].url.href).toBe(`${HAATZ}/v1/submitMessage`);
    expect(calls[1].init?.body).toBe(body);
    expect(calls[1].init?.method).toBe('POST');
  });

  it('a write does not fail over on 400 or 500: the node judged the message', async () => {
    for (const status of [400, 500]) {
      resetHypersnapFailover();
      const { fetchImpl, calls } = make(() => new Response('invalid signer', { status }));
      const res = await fetchImpl(`${HS1}/v1/submitMessage`, { method: 'POST', body: new Uint8Array([1]) });
      expect(res.status).toBe(status);
      expect(calls).toHaveLength(1);
    }
  });

  it('skips a node that just failed, then goes back to it after the cooldown', async () => {
    let hs1Up = false;
    const { fetchImpl, calls, clock } = make(url => (url.origin === HS1 && !hs1Up ? new Response('down', { status: 503 }) : json({ from: url.origin })));

    await fetchImpl(`${HS1}/v1/info`); // hs1 fails, haatz answers
    await fetchImpl(`${HS1}/v1/info`); // hs1 cooling down: haatz only
    expect(calls.map(c => c.url.origin)).toEqual([HS1, HAATZ, HAATZ]);

    hs1Up = true;
    clock.t += 31_000;
    const res = await fetchImpl(`${HS1}/v1/info`);
    expect(await res.json()).toEqual({ from: HS1 });
  });

  it('when every node fails, returns the last answer, or throws the last error', async () => {
    const all503 = make(() => new Response('down', { status: 503 }));
    const res = await all503.fetchImpl(`${HS1}/v1/info`);
    expect(res.status).toBe(503);
    expect(all503.calls).toHaveLength(2);

    resetHypersnapFailover();
    const allThrow = make(() => { throw new TypeError('no route'); });
    const err = await allThrow.fetchImpl(`${HS1}/v1/info`).catch(e => e);
    expect(err).toBeInstanceOf(TypeError);
    expect(allThrow.calls).toHaveLength(2);
  });

  it('still tries the nodes, primary first, when all of them are cooling down', async () => {
    let up = false;
    const { fetchImpl, calls } = make(url => (up ? json({ from: url.origin }) : new Response('down', { status: 503 })));
    await fetchImpl(`${HS1}/v1/info`);
    up = true;
    const res = await fetchImpl(`${HS1}/v1/info`);
    expect(await res.json()).toEqual({ from: HS1 });
    expect(calls).toHaveLength(3);
  });

  it('leaves other hosts alone', async () => {
    const { fetchImpl, calls } = make(() => new Response('down', { status: 503 }));
    const res = await fetchImpl('https://api.neynar.com/v2/farcaster/user/bulk?fids=1');
    expect(res.status).toBe(503);
    expect(calls).toHaveLength(1);
    // A host that merely starts with the primary's name is not the primary.
    await fetchImpl(`${HS1}.evil.example/v1/info`);
    expect(calls).toHaveLength(2);
  });
});

describe('native accounts through the data providers', () => {
  // GET /v2/farcaster/user/bulk?fids=4294967296 on hs1, 2026-11-15 (trimmed).
  const nativeWire = {
    object: 'user', fid: '4294967296', username: 'fid:4294967296',
    custody_address: '0x7f512e5395010964a57e1fcbe1dfe5a92e5cd91b',
    profile: { bio: { text: '' } }, follower_count: 0, following_count: 0,
    verified_addresses: { eth_addresses: [], sol_addresses: [], primary: {} },
  };

  it('a string fid becomes a number and the placeholder username is dropped', async () => {
    const { impl } = fakeFetch(() => json({ users: [nativeWire, { object: 'user', fid: 3321680, username: 'polls' }] }));
    const p = new NeynarDataProvider({ name: 'hypersnap', baseUrl: `${HS1}/v2/farcaster`, lacks: HYPERSNAP_LACKS, fetchImpl: impl });
    const users = await p.getUsers([4294967296, 3321680]);
    expect(users.map(u => u.fid)).toEqual([4294967296, 3321680]);
    expect(users[0].username).toBeUndefined();
    expect(users[0].custody_address).toBe('0x7f512e5395010964a57e1fcbe1dfe5a92e5cd91b');
    expect(users[1].username).toBe('polls');
  });

  it('the router finds a native account by its numeric fid and asks nobody else', async () => {
    const hs = fakeFetch(() => json({ users: [nativeWire] }));
    const neynar = fakeFetch(() => json({ users: [] }));
    const router = new FarcasterDataRouter([
      new NeynarDataProvider({ name: 'hypersnap', baseUrl: `${HS1}/v2/farcaster`, lacks: HYPERSNAP_LACKS, fetchImpl: hs.impl }),
      new NeynarDataProvider({ apiKey: 'k', fetchImpl: neynar.impl }),
    ]);
    const user = await router.getUser(4294967296);
    expect(user?.fid).toBe(4294967296);
    expect(user?.provider).toBe('hypersnap');
    expect(neynar.calls).toHaveLength(0);
  });

  it('drops a record whose fid is unusable instead of keying on it', async () => {
    const { impl } = fakeFetch(() => json({ users: [{ object: 'user', fid: 'abc' }, { object: 'user', fid: String(2 ** 40) }] }));
    const p = new NeynarDataProvider({ name: 'hypersnap', baseUrl: `${HS1}/v2/farcaster`, fetchImpl: impl });
    expect(await p.getUsers([1])).toEqual([]);
  });

  it('address → FID and best friends accept string fids', async () => {
    const { impl } = fakeFetch(url => (url.pathname.endsWith('/user/bulk-by-address')
      ? json({ '0xabc': [{ fid: '4294967297' }, { fid: 7 }] })
      : json({ users: [{ fid: '4294967298' }, { fid: 9 }, { fid: 'nope' }] })));
    const p = new NeynarDataProvider({ name: 'hypersnap', baseUrl: `${HS1}/v2/farcaster`, fetchImpl: impl });
    expect(await p.getFidsByAddresses(['0xABC'])).toEqual([7, 4294967297]);
    expect(await p.getBestFriends(1, 10)).toEqual([4294967298, 9]);
  });

  it('initFarcasterData fails over between nodes before it falls back to Neynar', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.origin === HS1) return new Response('down', { status: 503 });
      if (url.origin === HAATZ) return json({ users: [{ object: 'user', fid: 5, username: 'five' }] });
      throw new Error(`unexpected host ${url.origin}`);
    });
    const router = initFarcasterData({
      HYPERSNAP_ENDPOINT: HS1, HUB_ENDPOINT: HS1, HYPERSNAP_FALLBACK_ENDPOINTS: HAATZ, NEYNAR_API_KEY: 'k',
    });
    const user = await router.getUser(5);
    expect(user?.username).toBe('five');
    expect(user?.provider).toBe('hypersnap');
    expect(spy.mock.calls.map(c => new URL(String(c[0])).origin)).toEqual([HS1, HAATZ]);
  });
});

describe('HypersnapService writes after the fork', () => {
  const SIGNER_KEY = '0x' + '22'.repeat(32);

  it('signs for a native fid (>= 2^32) and submits', async () => {
    const { impl, calls } = fakeFetch(() => json({ hash: '0xnative' }));
    const svc = new HypersnapService({ endpoint: HS1, fetchImpl: impl });
    const r = await svc.publishCast({ signerKey: SIGNER_KEY, fid: 4294967296, text: 'hello from a native account' });
    expect(r.hash).toBe('0xnative');
    expect(r.author_fid).toBe(4294967296);
    expect(calls[0].url.href).toBe(`${HS1}/v1/submitMessage`);
  });

  it('treats a duplicate reply as success and returns the hash of the message it sent', async () => {
    let sent: Uint8Array | null = null;
    const { impl } = fakeFetch((_url, init) => {
      sent = init?.body as Uint8Array;
      return new Response(
        JSON.stringify({ error: 'Failed to submit message', error_detail: 'status: InvalidArgument, message: "bad_request.duplicate/message has already been merged"' }),
        { status: 400 },
      );
    });
    const svc = new HypersnapService({ endpoint: HS1, fetchImpl: impl });
    const r = await svc.publishCast({ signerKey: SIGNER_KEY, fid: 3321680, text: 'again' });
    expect(r.hash).toMatch(/^0x[0-9a-f]{40}$/);
    expect(r.hash).toBe(messageHashHex(sent!));
  });

  it('messageHashHex reads field 2, not the first bytes of the message', async () => {
    let sent: Uint8Array | null = null;
    const { impl } = fakeFetch((_url, init) => { sent = init?.body as Uint8Array; return json({}); });
    const svc = new HypersnapService({ endpoint: HS1, fetchImpl: impl });
    const r = await svc.publishCast({ signerKey: SIGNER_KEY, fid: 1, text: 'x' });
    const firstBytes = '0x' + Array.from(sent!.slice(0, 20)).map(b => b.toString(16).padStart(2, '0')).join('');
    expect(r.hash).not.toBe(firstBytes);
    expect(r.hash).toBe(messageHashHex(sent!));
  });

  it('still throws on a real rejection', async () => {
    const { impl } = fakeFetch(() => new Response('{"error_detail":"bad_request.validation_failure/invalid signer"}', { status: 400 }));
    const svc = new HypersnapService({ endpoint: HS1, fetchImpl: impl });
    const err = await svc.publishCast({ signerKey: SIGNER_KEY, fid: 1, text: 'x' }).catch(e => e);
    expect(err).toBeInstanceOf(HypersnapError);
    expect((err as HypersnapError).isSignerRevoked).toBe(true);
  });

  it('createHypersnapService replays a submit on the fallback node when the primary is unreachable', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.origin === HS1) throw new TypeError('connection refused');
      return json({ hash: '0xvia-haatz' });
    });
    const svc = createHypersnapService({ HYPERSNAP_ENDPOINT: HS1, HUB_ENDPOINT: HS1, HYPERSNAP_FALLBACK_ENDPOINTS: HAATZ });
    const r = await svc.publishCast({ signerKey: SIGNER_KEY, fid: 3321680, text: 'poll' });
    expect(r.hash).toBe('0xvia-haatz');
    expect(spy.mock.calls.map(c => String(c[0]))).toEqual([`${HS1}/v1/submitMessage`, `${HAATZ}/v1/submitMessage`]);
  });
});

describe('isFidSigner', () => {
  const KEY = '0x32c691f42a667c0cfb0509045fc8c4ad0122c785f2e2b3d57d99684a9fed6f4e';
  const NOT_FOUND = { error: 'Failed to get signer', error_detail: 'status: NotFound, message: "Active signer not found", details: [], metadata: MetadataMap { headers: {} }' };

  function fakeEnv() {
    const store = new Map<string, string>();
    const puts: Array<{ key: string; value: string; ttl?: number }> = [];
    return {
      store, puts,
      env: {
        HUB_ENDPOINT: HS1,
        HYPERSNAP_ENDPOINT: HS1,
        HYPERSNAP_FALLBACK_ENDPOINTS: HAATZ,
        KV_USER_PROFILES: {
          get: async (k: string) => store.get(k) ?? null,
          put: async (k: string, v: string, o?: { expirationTtl?: number }) => { store.set(k, v); puts.push({ key: k, value: v, ttl: o?.expirationTtl }); },
        },
      },
    };
  }
  const mockNode = (handler: (url: URL) => Response) =>
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => handler(new URL(String(input))));

  it('accepts a gasless key on a native account and caches the hit for an hour', async () => {
    const { env, puts } = fakeEnv();
    const spy = mockNode(() => json({ signer: {
      source: 'SIGNER_SOURCE_OFFCHAIN', key: KEY, keyType: 1, fid: '4294967296',
      addedAt: 1794667279, ttl: 2592000, expiresAt: Math.floor(Date.now() / 1000) + 86_400,
    } }));
    expect(await isFidSigner(env, 4294967296, KEY.toUpperCase().replace('0X', '0x'))).toBe(true);
    expect(String(spy.mock.calls[0][0])).toBe(`${HS1}/v1/signer?fid=4294967296&signer=${KEY}`);
    expect(puts).toEqual([{ key: `signer:4294967296:${KEY}`, value: '1', ttl: 3600 }]);
  });

  it('accepts an on-chain key, which has no expiry', async () => {
    const { env } = fakeEnv();
    mockNode(() => json({ signer: { source: 'SIGNER_SOURCE_ONCHAIN', key: KEY, keyType: 1, fid: 3321680, addedAt: 1777155153 } }));
    expect(await isFidSigner(env, 3321680, KEY)).toBe(true);
  });

  it('refuses a gasless key past its expiry', async () => {
    const { env, puts } = fakeEnv();
    mockNode(() => json({ signer: { source: 'SIGNER_SOURCE_OFFCHAIN', key: KEY, fid: '4294967296', expiresAt: Math.floor(Date.now() / 1000) - 10 } }));
    expect(await isFidSigner(env, 4294967296, KEY)).toBe(false);
    expect(puts[0]).toMatchObject({ value: '0', ttl: 300 });
  });

  it("caches the node's 'Active signer not found' as a miss", async () => {
    const { env, puts } = fakeEnv();
    mockNode(() => json(NOT_FOUND, 400));
    expect(await isFidSigner(env, 3321680, KEY)).toBe(false);
    expect(puts).toEqual([{ key: `signer:3321680:${KEY}`, value: '0', ttl: 300 }]);
  });

  it('does not cache a failure that is not a verdict', async () => {
    const { env, puts } = fakeEnv();
    mockNode(() => json({ error: 'Invalid query', error_detail: 'missing field' }, 400));
    expect(await isFidSigner(env, 3321680, KEY)).toBe(false);
    resetHypersnapFailover();
    mockNode(() => new Response('down', { status: 503 }));
    expect(await isFidSigner(env, 3321680, KEY)).toBe(false);
    expect(puts).toEqual([]);
  });

  it('asks the second node when the first is down', async () => {
    const { env } = fakeEnv();
    const spy = mockNode(url => (url.origin === HS1
      ? new Response('down', { status: 503 })
      : json({ signer: { source: 'SIGNER_SOURCE_ONCHAIN', key: KEY, fid: 3321680 } })));
    expect(await isFidSigner(env, 3321680, KEY)).toBe(true);
    expect(spy.mock.calls.map(c => new URL(String(c[0])).origin)).toEqual([HS1, HAATZ]);
  });

  it('falls back to the on-chain event log on a hub without /v1/signer', async () => {
    const { env } = fakeEnv();
    const other = '0x' + 'ab'.repeat(32);
    mockNode(url => (url.pathname === '/v1/signer'
      ? new Response('not routed', { status: 404 })
      : json({ events: [
        { signerEventBody: { key: KEY, eventType: 'SIGNER_EVENT_TYPE_ADD' } },
        { signerEventBody: { key: other, eventType: 'SIGNER_EVENT_TYPE_ADD' } },
        { signerEventBody: { key: other, eventType: 'SIGNER_EVENT_TYPE_REMOVE' } },
      ] })));
    expect(await isFidSigner(env, 3321680, KEY)).toBe(true);
    expect(await isFidSigner(env, 3321680, other)).toBe(false);
  });

  it('answers from the cache without a request', async () => {
    const { env, store } = fakeEnv();
    store.set(`signer:1:${KEY}`, '1');
    const spy = mockNode(() => { throw new Error('should not be called'); });
    expect(await isFidSigner(env, 1, KEY)).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });
});
