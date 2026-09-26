/**
 * /api/archive/waves/:id{,/bundle,/verify} and the admin trigger, against
 * local D1 with a fake ENS (the Universal Resolver read) and a fake gateway.
 * The tamper demo (plan §7.11) in miniature: edit a row with SQL, and
 * chain.matches stays true while live.matches flips to false.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { handleArchiveRoutes } from '../../worker/routes/archive';
import { commitWave } from '../../worker/services/archive/WaveCommitJob';
import type { EnsPort } from '../../worker/services/archive/EnsService';
import { WAVE, createSchema, seed } from '../services/archive/fixtures';

const ADMIN = 'admin-secret';
const onchain = new Map<string, string>();
const ens: EnsPort = {
  chainId: 11155111,
  isNamed: async () => true,
  canName: () => false,
  register: async () => { throw new Error('not used'); },
  writeQuestionRecords: async () => { throw new Error('not used'); },
  commit: async (name, r) => { onchain.set(`${name}|${r.pollId}`, r.bundleSha256); return `0x${'ab'.repeat(32)}`; },
  receipt: async () => 'success',
  readWaveHash: async (name, pollId) => onchain.get(`${name}|${pollId}`) ?? null,
  readText: async () => 'already written',
};
// Arweave stand-in: nothing reaches it, so the bundle is served by qbase
const noArweave = (async () => new Response('down', { status: 503 })) as unknown as typeof fetch;

const testEnv = () => ({ DB: env.DB, HOSTNAME: 'qbase-dev.example', ENS_WRITES_ENABLED: '1', ARCHIVE_PRIVATE_KEY: `0x${'33'.repeat(32)}`, QBASE_ADMIN_SECRET: ADMIN });
const get = (path: string) => handleArchiveRoutes(new Request(`https://x${path}`), testEnv(), { ens, fetch: noArweave });

describe('archive routes', () => {
  beforeAll(createSchema);
  beforeEach(async () => { onchain.clear(); await seed(); });

  it('404 before a wave is committed', async () => {
    expect((await get(`/api/archive/waves/${WAVE}`))!.status).toBe(404);
    expect((await get(`/api/archive/waves/${WAVE}/verify`))!.status).toBe(404);
  });

  it('admin commit needs the secret', async () => {
    const res = await handleArchiveRoutes(new Request(`https://x/api/admin/archive/waves/${WAVE}/commit`, { method: 'POST' }), testEnv(), { ens, fetch: noArweave });
    expect(res!.status).toBe(403);
  });

  it('commit → info + bundle; verify: chain and live both match; SQL tamper flips live only', async () => {
    const res = await handleArchiveRoutes(
      new Request(`https://x/api/admin/archive/waves/${WAVE}/commit`, { method: 'POST', headers: { 'X-Admin-Secret': ADMIN } }),
      testEnv(), { ens, fetch: noArweave },
    );
    const body = await res!.json() as { status: string; commitment: { bundle_url: string; tx_url: string; arweave: string | null } };
    expect(body.status).toBe('committed');
    expect(body.commitment.bundle_url).toBe(`https://qbase-dev.example/api/archive/waves/${WAVE}/bundle`);
    expect(body.commitment.tx_url).toBe(`https://sepolia.etherscan.io/tx/0x${'ab'.repeat(32)}`);
    expect(body.commitment.arweave).toBeNull();

    const bundle = await get(`/api/archive/waves/${WAVE}/bundle`);
    expect(bundle!.headers.get('Content-Type')).toBe('application/json');
    expect(JSON.parse(await bundle!.text()).schema).toBe('qbase.wave.v1');

    const ok = await (await get(`/api/archive/waves/${WAVE}/verify`))!.json() as { chain: { matches: boolean }; live: { matches: boolean } };
    expect(ok.chain.matches).toBe(true);
    expect(ok.live.matches).toBe(true);

    await env.DB.prepare(`UPDATE Answers SET value = 'yes' WHERE id = 'a1'`).run(); // wrangler d1 execute, in miniature
    const tampered = await (await get(`/api/archive/waves/${WAVE}/verify`))!.json() as { chain: { matches: boolean }; live: { matches: boolean; committed: { distribution: unknown }; now: { distribution: unknown } } };
    expect(tampered.chain.matches).toBe(true);
    expect(tampered.live.matches).toBe(false);
    expect(tampered.live.now!.distribution).toEqual([{ label: 'yes', count: 2 }, { label: 'no', count: 1 }]);
    expect(tampered.live.committed.distribution).toEqual([{ label: 'yes', count: 1 }, { label: 'no', count: 2 }]);
  });

  it('chain.matches is false when the on-chain hash differs from the bundle', async () => {
    await commitWave(testEnv(), WAVE, { ens, fetch: noArweave, receiptWaitMs: 0 });
    for (const k of onchain.keys()) onchain.set(k, `0x${'00'.repeat(32)}`);
    const r = await (await get(`/api/archive/waves/${WAVE}/verify`))!.json() as { chain: { matches: boolean } };
    expect(r.chain.matches).toBe(false);
  });

  it('with the bundle on Arweave, verify fetches it back from a gateway', async () => {
    let posted: Uint8Array | null = null;
    let id = '';
    const turbo = (async (url: string, init?: RequestInit) => {
      if (url.startsWith('https://upload.ardrive.io')) {
        posted = init!.body as Uint8Array;
        const sig = posted.slice(2, 67);
        id = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', sig)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        return new Response(JSON.stringify({ id }));
      }
      if (url === `https://turbo-gateway.com/${id}`) {
        const raw = posted!;
        const json = (await env.DB.prepare('SELECT bundle_json FROM wave_commitments').first() as { bundle_json: string }).bundle_json;
        expect(new TextDecoder().decode(raw.slice(raw.length - json.length))).toBe(json);
        return new Response(json);
      }
      return new Response('no', { status: 404 });
    }) as unknown as typeof fetch;
    await commitWave(testEnv(), WAVE, { ens, fetch: turbo, receiptWaitMs: 0 });
    const r = await (await handleArchiveRoutes(new Request(`https://x/api/archive/waves/${WAVE}/verify`), testEnv(), { ens, fetch: turbo }))!.json() as { chain: { matches: boolean; bundle_source: string } };
    expect(r.chain.bundle_source).toBe(`https://turbo-gateway.com/${id}`);
    expect(r.chain.matches).toBe(true);
  });
});
