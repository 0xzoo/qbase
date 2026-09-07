/**
 * HypersnapService writes — reactions ride the same /v1/submitMessage path as
 * casts (Track C card C5), and channel lookups read /v2/farcaster/channel.
 * Fetch is injected, so nothing leaves the test.
 */

import { describe, it, expect } from 'vitest';
import { HypersnapError, HypersnapService } from '../../worker/services/HypersnapService';

const SIGNER_KEY = '0x' + '22'.repeat(32);
const HASH = '0x' + 'cd'.repeat(20);

function fakeFetch(handler: (url: URL, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return { impl, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('HypersnapService reactions', () => {
  it('publishReaction POSTs a signed message to the hub and returns its hash', async () => {
    const { impl, calls } = fakeFetch(() => json({ hash: '0xreaction' }));
    const svc = new HypersnapService({ endpoint: 'https://haatz.test', hubEndpoint: 'https://hub.test/', fetchImpl: impl });

    const result = await svc.publishReaction({
      signerKey: SIGNER_KEY, fid: 975961, type: 'like', targetHash: HASH, targetAuthorFid: 7,
    });

    expect(result.hash).toBe('0xreaction');
    expect(calls).toHaveLength(1);
    expect(calls[0].url.href).toBe('https://hub.test/v1/submitMessage');
    expect(calls[0].init?.method).toBe('POST');
    expect(new Headers(calls[0].init?.headers).get('content-type')).toBe('application/octet-stream');
    expect(calls[0].init?.body).toBeInstanceOf(Uint8Array);
    expect((calls[0].init?.body as Uint8Array).length).toBeGreaterThan(100);
  });

  it('falls back to the blake3 hash of our own bytes when the hub echoes none', async () => {
    const { impl } = fakeFetch(() => json({}));
    const svc = new HypersnapService({ endpoint: 'https://hub.test', fetchImpl: impl });
    const r = await svc.publishReaction({ signerKey: SIGNER_KEY, fid: 1, type: 'like', targetHash: HASH, targetAuthorFid: 2 });
    expect(r.hash).toMatch(/^0x[0-9a-f]{40}$/);
  });

  it('removeReaction resolves on 2xx and throws HypersnapError otherwise', async () => {
    const ok = fakeFetch(() => json({}));
    await expect(
      new HypersnapService({ endpoint: 'https://hub.test', fetchImpl: ok.impl })
        .removeReaction({ signerKey: SIGNER_KEY, fid: 1, type: 'like', targetHash: HASH, targetAuthorFid: 2 }),
    ).resolves.toBeUndefined();

    const bad = fakeFetch(() => new Response('invalid signer', { status: 400 }));
    const err = await new HypersnapService({ endpoint: 'https://hub.test', fetchImpl: bad.impl })
      .removeReaction({ signerKey: SIGNER_KEY, fid: 1, type: 'like', targetHash: HASH, targetAuthorFid: 2 })
      .catch(e => e);
    expect(err).toBeInstanceOf(HypersnapError);
    expect((err as HypersnapError).isSignerRevoked).toBe(true);
  });
});

describe('HypersnapService.getChannel', () => {
  it('reads /v2/farcaster/channel?id= and returns the parent_url', async () => {
    const { impl, calls } = fakeFetch(() => json({
      channel: { object: 'channel', id: 'qbase', url: 'https://warpcast.com/~/channel/qbase', name: 'qbase', parent_url: 'https://warpcast.com/~/channel/qbase' },
    }));
    const svc = new HypersnapService({ endpoint: 'https://haatz.test', fetchImpl: impl });
    const ch = await svc.getChannel('qbase');
    expect(ch).toEqual({ id: 'qbase', url: 'https://warpcast.com/~/channel/qbase', parent_url: 'https://warpcast.com/~/channel/qbase', name: 'qbase' });
    expect(calls[0].url.href).toBe('https://haatz.test/v2/farcaster/channel?id=qbase');
  });

  it('returns null on 404', async () => {
    const { impl } = fakeFetch(() => new Response('not found', { status: 404 }));
    const svc = new HypersnapService({ endpoint: 'https://haatz.test', fetchImpl: impl });
    expect(await svc.getChannel('nope')).toBeNull();
  });
});
