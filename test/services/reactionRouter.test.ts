/**
 * ReactionRouter — likes / recasts through the first provider that has a
 * signer for the FID (Track C card C6). Fake providers pin the routing rules;
 * the hub provider runs against an injected fetch; the Neynar provider's
 * signer lookup runs against the pool's local D1 with a minimal
 * `user_signers` table (its REST calls are not exercised here).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { ReactionRouter, initReactionRouter } from '../../worker/services/casting/ReactionRouter';
import { HubReactionProvider } from '../../worker/services/casting/HubReactionProvider';
import { NeynarReactionProvider } from '../../worker/services/casting/NeynarReactionProvider';
import { hubSignerLookup } from '../../worker/services/casting/hubSignerLookup';
import type { ReactionPayload, ReactionProvider, ReactionResult } from '../../worker/services/casting/ReactionProvider';

const SIGNER_KEY = '0x' + '33'.repeat(32);
const HASH = '0x' + 'ef'.repeat(20);
const payload = (fid: number): ReactionPayload => ({ fid, type: 'like', targetHash: HASH, targetAuthorFid: 1 });

function fakeProvider(name: string, opts: { can: boolean; fail?: boolean }): ReactionProvider & { calls: string[] } {
  const calls: string[] = [];
  const run = async (op: string): Promise<ReactionResult> => {
    calls.push(op);
    if (opts.fail) throw new Error(`${name} down`);
    return { provider: name, hash: `0x${name}` };
  };
  return {
    name,
    calls,
    canReact: async () => opts.can,
    add: () => run('add'),
    remove: () => run('remove'),
  };
}

describe('hubSignerLookup', () => {
  it('maps bot FIDs to their secret keys, including the council accounts', async () => {
    const e = { QGENT_SIGNER_KEY: 'q', ANON_SIGNER_KEY: 'a', QLAUDE_SIGNER_KEY: 'l', CHATQPT_FID: '99', CHATQPT_SIGNER_KEY: 'c' };
    expect(await hubSignerLookup(975961, e)).toEqual({ key: 'q', fid: 975961 });
    expect(await hubSignerLookup(514282, e)).toEqual({ key: 'a', fid: 514282 });
    expect(await hubSignerLookup(1729350, e)).toEqual({ key: 'l', fid: 1729350 });
    expect(await hubSignerLookup(99, e)).toEqual({ key: 'c', fid: 99 });
    expect(await hubSignerLookup(1729438, e)).toBeNull(); // CHATQPT_FID overridden to 99
    expect(await hubSignerLookup(4242, e)).toBeNull();    // users: card C7
  });
});

describe('ReactionRouter', () => {
  it('uses the first provider that can react and skips the rest', async () => {
    const hub = fakeProvider('hub', { can: true });
    const neynar = fakeProvider('neynar', { can: true });
    const r = await new ReactionRouter([hub, neynar]).add(payload(1), {});
    expect(r.provider).toBe('hub');
    expect(neynar.calls).toEqual([]);
  });

  it('falls through when the first provider has no signer', async () => {
    const hub = fakeProvider('hub', { can: false });
    const neynar = fakeProvider('neynar', { can: true });
    const r = await new ReactionRouter([hub, neynar]).remove(payload(1), {});
    expect(r.provider).toBe('neynar');
    expect(neynar.calls).toEqual(['remove']);
  });

  it('falls through when the first provider throws', async () => {
    const hub = fakeProvider('hub', { can: true, fail: true });
    const neynar = fakeProvider('neynar', { can: true });
    const r = await new ReactionRouter([hub, neynar]).add(payload(1), {});
    expect(r.provider).toBe('neynar');
  });

  it('throws a summary when every provider fails or cannot react', async () => {
    const hub = fakeProvider('hub', { can: false });
    const neynar = fakeProvider('neynar', { can: true, fail: true });
    const err = await new ReactionRouter([hub, neynar]).add(payload(1), {}).catch(e => e);
    expect(String(err.message)).toContain('hub: cannot react');
    expect(String(err.message)).toContain('neynar: neynar down');
  });

  it('canReact is the OR over providers', async () => {
    expect(await new ReactionRouter([fakeProvider('a', { can: false }), fakeProvider('b', { can: true })]).canReact(1, {})).toBe(true);
    expect(await new ReactionRouter([fakeProvider('a', { can: false })]).canReact(1, {})).toBe(false);
  });

  it('initReactionRouter orders hub before neynar and needs at least one', () => {
    expect(initReactionRouter({ HUB_ENDPOINT: 'https://hub.test', NEYNAR_API_KEY: 'k' }).listProviders()).toEqual(['hub', 'neynar']);
    expect(initReactionRouter({ HYPERSNAP_ENDPOINT: 'https://hub.test' }).listProviders()).toEqual(['hub']);
    expect(() => initReactionRouter({})).toThrow(/No reaction providers/);
  });
});

describe('HubReactionProvider', () => {
  it('signs with the looked-up key and posts to the hub', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${init?.method} ${typeof input === 'string' ? input : (input as URL).href}`);
      return new Response(JSON.stringify({ hash: '0xlike' }), { status: 200 });
    }) as typeof fetch;
    const p = new HubReactionProvider({
      hubEndpoint: 'https://hub.test',
      signerLookup: async (fid) => (fid === 7 ? { key: SIGNER_KEY, fid } : null),
      fetchImpl,
    });
    expect(await p.canReact(7, {})).toBe(true);
    expect(await p.canReact(8, {})).toBe(false);
    expect(await p.add(payload(7), {})).toEqual({ hash: '0xlike', provider: 'hub' });
    expect(await p.remove(payload(7), {})).toEqual({ provider: 'hub' });
    expect(calls).toEqual(['POST https://hub.test/v1/submitMessage', 'POST https://hub.test/v1/submitMessage']);
    const err = await p.add(payload(8), {}).catch(e => e);
    expect(String(err.message)).toContain('No hub signer for FID 8');
  });
});

describe('NeynarReactionProvider.canReact (D1)', () => {
  beforeAll(async () => {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS user_signers (
         id INTEGER PRIMARY KEY AUTOINCREMENT, fid INTEGER NOT NULL, signer_uuid TEXT NOT NULL UNIQUE,
         public_key TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending_approval',
         provider TEXT NOT NULL DEFAULT 'neynar',
         created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,
    ).run();
    await env.DB.prepare(
      `INSERT OR IGNORE INTO user_signers (fid, signer_uuid, public_key, status, provider) VALUES
         (100, 'uuid-100', '0xpk', 'approved', 'neynar'),
         (101, 'uuid-101', '0xpk', 'pending_approval', 'neynar'),
         (102, 'uuid-102', '0xpk', 'approved', 'hypersnap')`,
    ).run();
  });

  it('is true only for an approved Neynar signer with an API key present', async () => {
    const p = new NeynarReactionProvider();
    const e = { DB: env.DB, NEYNAR_API_KEY: 'k' };
    expect(await p.canReact(100, e)).toBe(true);
    expect(await p.canReact(101, e)).toBe(false);
    expect(await p.canReact(102, e)).toBe(false);
    expect(await p.canReact(100, { DB: env.DB })).toBe(false);
  });
});
