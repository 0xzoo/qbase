/**
 * AllowlistGraphHelper — besties and follow checks through an injected router
 * (Track C card C10): no Neynar key needed, results cached 10 min in KV.
 */

import { describe, it, expect } from 'vitest';
import { AllowlistGraphHelper } from '../../worker/services/AllowlistGraphHelper';
import type { FarcasterDataRouter } from '../../worker/services/farcaster';

function routerStub(rel: { following: boolean; followed_by: boolean } | Error, besties: number[] = [1, 2, 3]) {
  const calls: string[] = [];
  const r = {
    getBestFriends: async (fid: number, limit: number) => { calls.push(`besties:${fid}:${limit}`); return besties.slice(0, limit); },
    getRelationship: async (a: number, b: number) => { calls.push(`rel:${a}:${b}`); if (rel instanceof Error) throw rel; return rel; },
  } as unknown as FarcasterDataRouter;
  return { r, calls };
}

function kvStub() {
  const store = new Map<string, string>();
  return { store, get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => { store.set(k, v); } };
}

describe('AllowlistGraphHelper', () => {
  it('importBesties goes through the router', async () => {
    const { r, calls } = routerStub({ following: false, followed_by: false }, [9, 8, 7, 6]);
    expect(await AllowlistGraphHelper.importBesties({}, 42, 2, r)).toEqual([9, 8]);
    expect(calls).toEqual(['besties:42:2']);
  });

  it('follow checks read the relationship once and cache it', async () => {
    const { r, calls } = routerStub({ following: true, followed_by: false });
    const kv = kvStub();
    expect(await AllowlistGraphHelper.checkIFollow({}, 1, 2, kv, r)).toBe(true);
    expect(await AllowlistGraphHelper.checkIFollow({}, 1, 2, kv, r)).toBe(true);
    expect(calls).toEqual(['rel:1:2']);
    expect(kv.store.get('graph:i_follow:1:2')).toBe('1');
    expect(await AllowlistGraphHelper.checkFollowsMe({}, 1, 2, kv, r)).toBe(false);
    expect(await AllowlistGraphHelper.checkMutualFollow({}, 1, 2, kv, r)).toBe(false);
  });

  it('checkRelationship routes list types; a router failure is false, not a throw', async () => {
    const ok = routerStub({ following: true, followed_by: true });
    expect(await AllowlistGraphHelper.checkRelationship({}, 1, 2, 'mutual_followers', undefined, ok.r)).toBe(true);
    expect(await AllowlistGraphHelper.checkRelationship({}, 1, 2, 'nonsense', undefined, ok.r)).toBe(false);
    const down = routerStub(new Error('no provider'));
    expect(await AllowlistGraphHelper.checkRelationship({}, 1, 2, 'my_followers', undefined, down.r)).toBe(false);
  });
});
