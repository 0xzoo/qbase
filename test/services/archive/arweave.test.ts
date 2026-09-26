/**
 * ANS-104 data items signed with an Ethereum key, as ArDrive Turbo takes them.
 * Vectors were produced by `@dha-team/arbundles` 1.0.4 (the signer inside
 * @ardrive/turbo-sdk) and matched byte for byte on 2026-09-26; the contenthash
 * vector by `@ensdomains/content-hash` 3.1.1 `encode('arweave', id)`.
 */
import { describe, it, expect } from 'vitest';
import { arweaveContenthash, deepHash, fetchFromArweave, postBundle, signDataItem, ArweaveUnavailable } from '../../../worker/services/archive/ArweaveService';

const PK = `0x${'11'.repeat(32)}` as const;
const DATA = new TextEncoder().encode('{"schema":"qbase.wave.v1","n":3}');
const TAGS = [{ name: 'Content-Type', value: 'application/json' }, { name: 'App-Name', value: 'qbase' }, { name: 'Wave-Id', value: 'w-1' }];

describe('ANS-104 Ethereum data item', () => {
  it('matches arbundles: id and length', async () => {
    const item = await signDataItem(PK, DATA, TAGS);
    expect(item.id).toBe('x1qlkeQU-SqGON-4owblbxveuUd3QJcLa4Mww-0afwU');
    expect(item.raw.length).toBe(241);
    expect(item.raw[0]).toBe(3); // signature type 3, little-endian
    expect(item.raw[1]).toBe(0);
  });

  it('deep hash is sha384-sized and distinguishes a blob from a one-item list', async () => {
    const blob = await deepHash(DATA);
    expect(blob.length).toBe(48);
    expect(Buffer.from(await deepHash([DATA])).equals(Buffer.from(blob))).toBe(false);
  });

  it('contenthash = arweave multicodec + the 32 id bytes', () => {
    expect(arweaveContenthash('3wxuQsKMIbc6PD0x9r3Quo82aNOOv_FAwtI4lEMIbHE'))
      .toBe('0x90b2ca05df0c6e42c28c21b73a3c3d31f6bdd0ba8f3668d38ebff140c2d2389443086c71');
    expect(() => arweaveContenthash('short')).toThrow();
  });
});

describe('postBundle / fetchFromArweave', () => {
  it('refuses without a key', async () => {
    await expect(postBundle({}, '{}', [])).rejects.toBeInstanceOf(ArweaveUnavailable);
  });

  it('posts the raw item to Turbo and checks the id it returns', async () => {
    const calls: Array<{ url: string; body: Uint8Array }> = [];
    const expected = (await signDataItem(PK, new TextEncoder().encode('{"a":1}'), TAGS)).id;
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: init.body as Uint8Array });
      return new Response(JSON.stringify({ id: expected, winc: '0' }), { status: 200 });
    }) as unknown as typeof fetch;
    const id = await postBundle({ ARCHIVE_PRIVATE_KEY: PK }, '{"a":1}', TAGS, fake);
    expect(id).toBe(expected);
    expect(calls[0].url).toBe('https://upload.ardrive.io/v1/tx/ethereum');
  });

  it('refuses a bundle over the free limit before posting', async () => {
    await expect(postBundle({ ARCHIVE_PRIVATE_KEY: PK }, 'x'.repeat(101 * 1024), [])).rejects.toBeInstanceOf(ArweaveUnavailable);
  });

  it('falls through gateways', async () => {
    const fake = (async (url: string) => url.startsWith('https://turbo-gateway.com') ? new Response('nope', { status: 404 }) : new Response('{"ok":1}')) as unknown as typeof fetch;
    expect(await fetchFromArweave('abc', fake)).toEqual({ text: '{"ok":1}', gateway: 'https://arweave.net' });
  });
});
