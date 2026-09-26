/**
 * qbase handles (worker/services/accounts/HandleService.ts, migration 0077).
 *
 * The migration on messy data (normalize, fill from fname / verified ENS,
 * deterministic duplicate resolution, unique index), the pick rules including
 * the Farcaster-username collision, best-effort seeding, and the routes:
 * by-handle, check-username and the profile PATCH.
 */

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import accountsMigration from '../../migrations/0076_accounts.sql?raw';
import handlesMigration from '../../migrations/0077_handles.sql?raw';
import { checkHandle, seedHandle, setHandle } from '../../worker/services/accounts/HandleService';
import { handleUserRoutes } from '../../worker/routes/users';
import { createAccountSession } from '../../worker/routes/account';
import { _resetAccountCaches } from '../../worker/services/accounts/AccountService';
import { ACCOUNT_ID_MIN } from '../../worker/services/accounts/migrationSql';

const A = ACCOUNT_ID_MIN + 1; // Farcaster account, fname alice, no username yet
const B = ACCOUNT_ID_MIN + 2; // native squatter on "Alice "
const C = ACCOUNT_ID_MIN + 3; // Ethereum, verified bob.eth
const D = ACCOUNT_ID_MIN + 4; // Ethereum, carol.eth not verified
const G = ACCOUNT_ID_MIN + 7; // "dup"
const H = ACCOUNT_ID_MIN + 8; // "dup"
const W = ACCOUNT_ID_MIN + 9; // World account, no name
const ANON_BOT = 514282;
const BAD = ACCOUNT_ID_MIN + 10;

const noFc = { ...env, FC_DATA_PROVIDER_ORDER: '' };

function statements(sql: string): string[] {
  return sql.replace(/--.*$/gm, '').split(';').map(s => s.trim()).filter(Boolean);
}

async function call(path: string, init: RequestInit = {}, token?: string, e: unknown = noFc) {
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init.body) headers.set('Content-Type', 'application/json');
  headers.set('CF-Connecting-IP', `10.1.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`);
  const res = await handleUserRoutes(new Request(`https://qbase.tech${path}`, { ...init, headers }), e);
  return { status: res!.status, body: await res!.json().catch(() => null) as Record<string, any> };
}

const handleOf = async (fid: number) =>
  (await env.DB.prepare('SELECT username FROM Users WHERE fid = ?').bind(fid).first() as { username: string | null } | null)?.username ?? null;

describe('handles', () => {
  beforeAll(async () => {
    _resetAccountCaches();
    await env.DB.batch(['Users', 'accounts', 'account_credentials', 'account_migration', 'account_rewrite_log'].map(t => env.DB.prepare(`DROP TABLE IF EXISTS ${t}`)));
    await env.DB.prepare(`CREATE TABLE Users (
      fid INTEGER PRIMARY KEY, fname TEXT, created_at NUMBER DEFAULT CURRENT_TIMESTAMP, primary_address TEXT,
      q_cost NUMBER DEFAULT 3, socials TEXT, pro_status TEXT, pro_expires_at TEXT, username TEXT, quil_address TEXT,
      fc_opt_in INTEGER DEFAULT 0, display_name TEXT, pfp_url TEXT, bio TEXT, profile_source TEXT DEFAULT 'farcaster')`).run();
    for (const s of statements(accountsMigration)) await env.DB.prepare(s).run();
    await env.DB.prepare(`INSERT INTO account_migration (id, state, rewritten_at) VALUES (1, 'rewritten', 1)`).run();

    const users: [number, string | null, string | null, string][] = [
      [A, 'alice', null, 'farcaster'],
      [B, 'someone', 'Alice ', 'native'],
      [C, 'bob.eth', null, 'ethereum'],
      [D, 'carol.eth', null, 'ethereum'],
      [G, 'g', 'dup', 'native'],
      [H, 'h', 'dup', 'native'],
      [W, 'world-000009', null, 'world'],
      [ANON_BOT, '4n0n', '4n0n', 'farcaster'],
      [BAD, 'x', 'bad name!', 'native'],
    ];
    for (const [fid, fname, username, source] of users) {
      await env.DB.prepare('INSERT INTO Users (fid, fname, username, profile_source, display_name) VALUES (?, ?, ?, ?, ?)')
        .bind(fid, fname, username, source, fname).run();
    }
    const creds: [string, string, number, string | null][] = [
      ['farcaster', '100', A, 'alice'],
      ['ethereum', '0xc', C, 'bob.eth'],
      ['ethereum', '0xd', D, null],
      ['world', 'iss|w', W, 'World ID'],
    ];
    for (const [kind, value, acc, label] of creds) {
      await env.DB.prepare('INSERT INTO account_credentials (kind, value, account_id, label, created_at) VALUES (?, ?, ?, ?, 1)').bind(kind, value, acc, label).run();
    }
    for (const s of statements(handlesMigration)) await env.DB.prepare(s).run();
  });

  afterEach(() => vi.restoreAllMocks());

  it('migration: fills from fname and verified ENS, the proved name wins a duplicate, invalid names cleared', async () => {
    expect(await handleOf(A)).toBe('alice');       // proved on Farcaster
    expect(await handleOf(B)).toBeNull();          // lost "alice" to A
    expect(await handleOf(C)).toBe('bob.eth');     // verified ENS label
    expect(await handleOf(D)).toBeNull();          // ENS not verified on the credential
    expect(await handleOf(G)).toBe('dup');         // lower key wins a tie
    expect(await handleOf(H)).toBeNull();
    expect(await handleOf(W)).toBeNull();          // asked to pick
    expect(await handleOf(ANON_BOT)).toBe('4n0n'); // placeholder rows keep theirs
    expect(await handleOf(BAD)).toBeNull();
  });

  it('migration: the unique index holds', async () => {
    await expect(env.DB.prepare('UPDATE Users SET username = ? WHERE fid = ?').bind('alice', B).run()).rejects.toThrow(/UNIQUE/);
  });

  it('checkHandle: format, reserved, taken, own handle', async () => {
    expect(await checkHandle(noFc, 'ab', W)).toMatchObject({ ok: false, code: 'invalid' });
    expect(await checkHandle(noFc, 'has.dot', W)).toMatchObject({ ok: false, code: 'invalid' });
    expect(await checkHandle(noFc, '-edge', W)).toMatchObject({ ok: false, code: 'invalid' });
    expect(await checkHandle(noFc, 'polls', W)).toMatchObject({ ok: false, code: 'reserved' });
    expect(await checkHandle(noFc, '@Alice', W)).toMatchObject({ ok: false, code: 'taken', handle: 'alice' });
    expect(await checkHandle(noFc, 'alice', A)).toEqual({ ok: true, handle: 'alice' });
    expect(await checkHandle(noFc, 'wren_01', W)).toEqual({ ok: true, handle: 'wren_01' });
  });

  it('checkHandle: a Farcaster username held by an unlinked fid is not up for grabs', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('by_username') && url.includes('username=dwr')) {
        return Response.json({ user: { fid: 3, username: 'dwr', display_name: 'Dan', pfp_url: '', profile: { bio: { text: '' } }, follower_count: 1, following_count: 1, verifications: [] } });
      }
      if (url.includes('by_username') && url.includes('username=alice')) {
        return Response.json({ user: { fid: 100, username: 'alice', display_name: 'Alice', pfp_url: '', profile: { bio: { text: '' } }, follower_count: 1, following_count: 1, verifications: [] } });
      }
      return new Response('{"message":"not found"}', { status: 404 });
    });
    const withFc = { ...env, FC_DATA_PROVIDER_ORDER: 'hypersnap', HYPERSNAP_ENDPOINT: 'https://hub.test' };
    expect(await checkHandle(withFc, 'dwr', W)).toMatchObject({ ok: false, code: 'farcaster_taken' });
    expect(await checkHandle(withFc, 'alice', A)).toEqual({ ok: true, handle: 'alice' }); // A holds fid 100
    expect(await checkHandle(withFc, 'nobody-here', W)).toEqual({ ok: true, handle: 'nobody-here' });
  });

  it('seedHandle never overwrites and never throws on a taken name', async () => {
    await seedHandle(noFc, B, 'alice');       // taken by A
    expect(await handleOf(B)).toBeNull();
    await seedHandle(noFc, A, 'someone-else'); // A already has one
    expect(await handleOf(A)).toBe('alice');
    await seedHandle(noFc, D, 'Carol.eth');
    expect(await handleOf(D)).toBe('carol.eth');
    await env.DB.prepare('UPDATE Users SET username = NULL WHERE fid = ?').bind(D).run();
  });

  it('setHandle loses a race to the unique index with "taken"', async () => {
    expect(await setHandle(noFc, H, 'dup')).toBe('taken');
  });

  it('GET /api/users/by-handle serves accounts only', async () => {
    const r = await call('/api/users/by-handle/Alice');
    expect(r.status).toBe(200);
    expect(r.body.profile).toMatchObject({ account_id: A, handle: 'alice', display_name: 'alice' });
    expect((await call('/api/users/by-handle/4n0n')).status).toBe(404); // placeholder row, not an account
    expect((await call('/api/users/by-handle/nobody')).status).toBe(404);
  });

  it('check-username and PATCH profile apply the same rules', async () => {
    const { sessionToken } = await createAccountSession(env, W, 'world');
    expect((await call('/api/users/check-username', { method: 'POST', body: JSON.stringify({ username: 'alice' }) }, sessionToken)).body)
      .toMatchObject({ available: false, code: 'taken' });
    expect((await call('/api/users/check-username', { method: 'POST', body: JSON.stringify({ username: 'wren' }) }, sessionToken)).body)
      .toEqual({ available: true, handle: 'wren' });

    const bad = await call('/api/users/profile', { method: 'PATCH', body: JSON.stringify({ username: 'q' }) }, sessionToken);
    expect(bad.status).toBe(400);
    const taken = await call('/api/users/profile', { method: 'PATCH', body: JSON.stringify({ username: 'alice' }) }, sessionToken);
    expect(taken.status).toBe(409);

    const ok = await call('/api/users/profile', { method: 'PATCH', body: JSON.stringify({ username: 'Wren' }) }, sessionToken);
    expect(ok.status).toBe(200);
    expect(ok.body.user).toMatchObject({ username: 'wren' });
    // A handle-only edit does not turn the row into a "native" profile.
    expect(await env.DB.prepare('SELECT profile_source FROM Users WHERE fid = ?').bind(W).first()).toEqual({ profile_source: 'world' });

    const me = await call('/api/users/me', {}, sessionToken);
    expect(me.body.user).toMatchObject({ account_id: W, handle: 'wren', fid: null });
  });
});
