/**
 * Sign-in methods and credential linking (docs/specs/account-root.md §6.2).
 *
 * SIWE with a real signature from a local key (the ENS lookup is stubbed; the
 * binding is to the address, the name is only a label), single-use nonces,
 * linking and unlinking rules, refusal before the cutover, and ID-token
 * validation for World ID with a locally generated key.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { env } from 'cloudflare:test';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import migration from '../../migrations/0076_accounts.sql?raw';
import { handleAccountRoutes } from '../../worker/routes/account';
import { requireFlexibleAuth } from '../../worker/middleware/auth';
import { setSiweDepsForTests } from '../../worker/services/accounts/SiweLogin';
import { verifyIdToken } from '../../worker/services/accounts/WorldLogin';
import { _resetAccountCaches } from '../../worker/services/accounts/AccountService';
import { ACCOUNT_ID_MIN } from '../../worker/services/accounts/migrationSql';

const ORIGIN = 'https://qbase.tech';
const alice = privateKeyToAccount(generatePrivateKey());
const bob = privateKeyToAccount(generatePrivateKey());
let ensNames: Record<string, string | null> = {};

async function call(path: string, init: RequestInit = {}, token?: string) {
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init.body) headers.set('Content-Type', 'application/json');
  headers.set('CF-Connecting-IP', `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`); // the per-IP rate gate is not under test
  const res = await handleAccountRoutes(new Request(`${ORIGIN}${path}`, { ...init, headers }), env);
  return { status: res!.status, body: await res!.json().catch(() => null) as Record<string, any> };
}

async function siweBody(who: typeof alice, opts: { nonce?: string; domain?: string } = {}) {
  const nonce = opts.nonce ?? (await call('/api/auth/siwe/nonce')).body.nonce;
  const message = createSiweMessage({
    address: who.address, chainId: 1, domain: opts.domain ?? 'qbase.tech', nonce, uri: ORIGIN, version: '1',
    issuedAt: new Date(), expirationTime: new Date(Date.now() + 5 * 60_000),
  });
  return { message, signature: await who.signMessage({ message }) };
}
const login = async (who: typeof alice) => call('/api/auth/siwe/verify', { method: 'POST', body: JSON.stringify(await siweBody(who)) });

describe('account sign-in', () => {
  beforeAll(async () => {
    _resetAccountCaches();
    setSiweDepsForTests({ resolveEnsName: async (_e, a) => ensNames[a.toLowerCase()] ?? null, verifyViaRpc: async () => false });
    await env.DB.batch(['Users', 'accounts', 'account_credentials', 'account_migration', 'account_rewrite_log'].map(t => env.DB.prepare(`DROP TABLE IF EXISTS ${t}`)));
    await env.DB.prepare(`CREATE TABLE Users (fid INTEGER PRIMARY KEY, fname TEXT, display_name TEXT, profile_source TEXT, quil_address TEXT)`).run();
    for (const stmt of migration.replace(/--.*$/gm, '').split(';').map(s => s.trim()).filter(Boolean)) await env.DB.prepare(stmt).run();
    ensNames = { [alice.address.toLowerCase()]: 'alice.eth' };
  });
  afterAll(() => setSiweDepsForTests(null));

  it('is refused before the cutover', async () => {
    expect((await call('/api/auth/methods')).body).toEqual({ ethereum: false, world: false });
    expect((await call('/api/auth/siwe/nonce')).status).toBe(503);
  });

  it('signs in with Ethereum: account bound to the address, ENS name as the label', async () => {
    await env.DB.prepare(`INSERT INTO account_migration (id, state, rewritten_at) VALUES (1, 'rewritten', 1)`).run();
    _resetAccountCaches();
    expect((await call('/api/auth/methods')).body).toEqual({ ethereum: true, world: false });

    const r = await login(alice);
    expect(r.status).toBe(200);
    expect(r.body.accountId).toBeGreaterThanOrEqual(ACCOUNT_ID_MIN);
    expect(r.body.ensName).toBe('alice.eth');
    expect(await env.DB.prepare('SELECT fname, profile_source FROM Users WHERE fid = ?').bind(r.body.accountId).first()).toEqual({ fname: 'alice.eth', profile_source: 'ethereum' });

    const auth = await requireFlexibleAuth(new Request(`${ORIGIN}/x`, { headers: { Authorization: `Bearer ${r.body.sessionToken}` } }), env);
    expect(auth).toMatchObject({ authenticated: true, accountId: r.body.accountId, userKey: r.body.accountId, via: 'ethereum' });
    expect(auth.fid).toBeUndefined();

    // Same address again → same account, even after the name moves away.
    ensNames[alice.address.toLowerCase()] = null;
    expect((await login(alice)).body.accountId).toBe(r.body.accountId);
  });

  it('rejects a replayed nonce, a wrong domain and a bad signature', async () => {
    const body = await siweBody(alice);
    expect((await call('/api/auth/siwe/verify', { method: 'POST', body: JSON.stringify(body) })).status).toBe(200);
    expect((await call('/api/auth/siwe/verify', { method: 'POST', body: JSON.stringify(body) })).body.error).toBe('nonce_expired');

    const wrongDomain = await siweBody(alice, { domain: 'evil.example' });
    expect((await call('/api/auth/siwe/verify', { method: 'POST', body: JSON.stringify(wrongDomain) })).body.error).toBe('invalid_message');

    const forged = await siweBody(alice);
    forged.signature = await bob.signMessage({ message: forged.message });
    expect((await call('/api/auth/siwe/verify', { method: 'POST', body: JSON.stringify(forged) })).body.error).toBe('bad_signature');
  });

  it('links a second wallet, refuses one owned elsewhere, and never removes the last credential', async () => {
    const a = (await login(alice)).body;
    const link = await call('/api/auth/siwe/verify', { method: 'POST', body: JSON.stringify({ ...(await siweBody(bob)), link: true }) }, a.sessionToken);
    expect(link.body).toMatchObject({ linked: 'ethereum' });
    const creds = (await call('/api/account/credentials', {}, a.sessionToken)).body.credentials;
    expect(creds.map((c: { value: string }) => c.value).sort()).toEqual([alice.address.toLowerCase(), bob.address.toLowerCase()].sort());

    // bob now signs in straight into alice's account
    expect((await login(bob)).body.accountId).toBe(a.accountId);

    // a third wallet with its own account cannot be linked into alice's
    const carol = privateKeyToAccount(generatePrivateKey());
    await login(carol);
    const steal = await call('/api/auth/siwe/verify', { method: 'POST', body: JSON.stringify({ ...(await siweBody(carol)), link: true }) }, a.sessionToken);
    expect(steal).toMatchObject({ status: 409, body: { error: 'credential_in_use' } });

    const rm = await call(`/api/account/credentials/ethereum/${bob.address.toLowerCase()}`, { method: 'DELETE' }, a.sessionToken);
    expect(rm.status).toBe(200);
    const last = await call(`/api/account/credentials/ethereum/${alice.address.toLowerCase()}`, { method: 'DELETE' }, a.sessionToken);
    expect(last).toMatchObject({ status: 409, body: { error: 'last_credential' } });
  });

  it('World ID login is off until configured', async () => {
    expect((await call('/api/auth/world/start', { method: 'POST', body: '{}' })).body.error).toBe('world_login_unconfigured');
  });
});

describe('World ID token validation', () => {
  const b64url = (b: Uint8Array | string) => btoa(typeof b === 'string' ? b : String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  let priv: CryptoKey;
  let jwks: { keys: JsonWebKey[] };
  const now = Math.floor(Date.now() / 1000);
  const base = { iss: 'https://sandbox.auth.world.org', sub: 'user-123', aud: 'client-1', exp: now + 300, auth_time: now - 10, nonce: 'n1' };

  beforeAll(async () => {
    const kp = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
    priv = kp.privateKey;
    jwks = { keys: [{ ...(await crypto.subtle.exportKey('jwk', kp.publicKey)), kid: 'k1' } as JsonWebKey] };
  });
  async function sign(claims: Record<string, unknown>, kid = 'k1') {
    const head = b64url(JSON.stringify({ alg: 'RS256', kid }));
    const body = b64url(JSON.stringify(claims));
    const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', priv, new TextEncoder().encode(`${head}.${body}`)));
    return `${head}.${body}.${b64url(sig)}`;
  }
  const check = (t: string) => verifyIdToken(t, { issuer: base.iss, audience: 'client-1', jwks, nonce: 'n1' });

  it('accepts a valid token and names the subject', async () => {
    expect((await check(await sign(base))).sub).toBe('user-123');
  });
  it('rejects wrong audience, issuer, nonce, expiry, stale auth and a tampered payload', async () => {
    await expect(check(await sign({ ...base, aud: 'other' }))).rejects.toThrow('wrong_audience');
    await expect(check(await sign({ ...base, iss: 'https://evil' }))).rejects.toThrow('wrong_issuer');
    await expect(check(await sign({ ...base, nonce: 'n2' }))).rejects.toThrow('wrong_nonce');
    await expect(check(await sign({ ...base, exp: now - 1 }))).rejects.toThrow('expired');
    await expect(check(await sign({ ...base, auth_time: now - 3600 }))).rejects.toThrow('stale_auth');
    const t = (await sign(base)).split('.');
    t[1] = b64url(JSON.stringify({ ...base, sub: 'someone-else' }));
    await expect(check(t.join('.'))).rejects.toThrow('bad_signature');
  });
});
