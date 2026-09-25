/**
 * Human-approved agent actions (plan §6.4).
 *
 * The World IdP is mocked (a fetch stub serving discovery, JWKS, device
 * authorization and a scripted token endpoint; ID tokens are signed with a
 * key generated here). Everything else runs against the pool's local D1 with
 * the real migration 0074.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import migration from '../../migrations/0074_agent_approvals.sql?raw';
import { handleAgentApprovalRoutes } from '../../worker/routes/agent-approvals';
import { verifyIdToken, IdpError, type IdpConfig } from '../../worker/services/WorldIdpService';
import {
  classifyTokenResponse, nextState, openDeviceCode, sealDeviceCode, MAX_ATTEMPT_S, type TokenOutcome,
} from '../../worker/services/AgentApprovalService';

const ISSUER = 'https://idp.test';
const CLIENT_ID = 'client_qbase';
const CLIENT_SECRET = 'secret-shhh';
const CFG: IdpConfig = { issuer: ISSUER, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET };
const AGENT_KEY = 'qgent-key-0123456789abcdef';
const OTHER_KEY = 'other-key-0123456789abcdef';
const Q = '22222222-2222-4222-8222-222222222222';
const T0 = 1_790_000_000;

// ── Keys and tokens ──────────────────────────────────────────────────────

const b64url = (b: Uint8Array | string) => {
  const bytes = typeof b === 'string' ? new TextEncoder().encode(b) : b;
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

async function rsaKey(kid: string) {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify'],
  ) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey) as JsonWebKey;
  return { kid, privateKey: pair.privateKey, jwk: { ...jwk, kid, use: 'sig', alg: 'RS256' } };
}

let KEY: Awaited<ReturnType<typeof rsaKey>>;
let IMPOSTOR: Awaited<ReturnType<typeof rsaKey>>;

async function sign(claims: Record<string, unknown>, key = KEY, header: Record<string, unknown> = {}) {
  const h = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: key.kid, ...header }));
  const p = b64url(JSON.stringify(claims));
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key.privateKey, new TextEncoder().encode(`${h}.${p}`)));
  return `${h}.${p}.${b64url(sig)}`;
}

function claims(over: Record<string, unknown> = {}, at = T0 + 30) {
  return { iss: ISSUER, sub: 'human-owner', aud: CLIENT_ID, exp: at + 300, iat: at, auth_time: at, ...over };
}

// ── Mock IdP ─────────────────────────────────────────────────────────────

type TokenReply = { status: number; body: Record<string, unknown> } | (() => Promise<{ status: number; body: Record<string, unknown> }>);

function mockIdp() {
  const tokenQueue: TokenReply[] = [];
  const calls: Array<{ url: string; auth: string | null; body: string }> = [];
  let deviceSeq = 0;
  const fetchImpl = (async (input: string | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url;
    const auth = new Headers(init?.headers).get('Authorization');
    calls.push({ url, auth, body: init?.body ? String(init.body) : '' });
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return Response.json({
        issuer: ISSUER,
        token_endpoint: `${ISSUER}/api/v1/token`,
        device_authorization_endpoint: `${ISSUER}/api/v1/device_authorization`,
        jwks_uri: `${ISSUER}/.well-known/jwks.json`,
      });
    }
    if (url === `${ISSUER}/.well-known/jwks.json`) return Response.json({ keys: [KEY.jwk] });
    if (url === `${ISSUER}/api/v1/device_authorization`) {
      deviceSeq++;
      return Response.json({
        device_code: `DEVICE-CODE-SECRET-${deviceSeq}`,
        user_code: `ABCD-000${deviceSeq}`,
        verification_uri: `${ISSUER}/device`,
        verification_uri_complete: `${ISSUER}/device?user_code=ABCD-000${deviceSeq}`,
        expires_in: 1800,
        interval: 5,
      });
    }
    if (url === `${ISSUER}/api/v1/token`) {
      const next = tokenQueue.shift();
      if (!next) throw new Error('unexpected token call');
      const r = typeof next === 'function' ? await next() : next;
      return Response.json(r.body, { status: r.status });
    }
    throw new Error(`unmocked ${url}`);
  }) as unknown as typeof fetch;
  const tokenCalls = () => calls.filter(c => c.url.endsWith('/api/v1/token'));
  return { fetchImpl, calls, tokenCalls, tokenQueue };
}

const pending = { status: 400, body: { error: 'authorization_pending' } };
const slowDown = { status: 400, body: { error: 'slow_down' } };
const tokenReply = (idToken: string) => ({ status: 200, body: { access_token: 'at', token_type: 'Bearer', id_token: idToken } });

// ── Harness ──────────────────────────────────────────────────────────────

const testEnv = (over: Record<string, unknown> = {}) => ({
  DB: env.DB,
  // No RATE_LIMIT binding: the service allows when it is absent, and the suite would trip 60/min.
  AGENT_APPROVAL_ENABLED: '1',
  WORLD_IDP_ISSUER: ISSUER,
  WORLD_IDP_CLIENT_ID: CLIENT_ID,
  WORLD_IDP_CLIENT_SECRET: CLIENT_SECRET,
  AGENT_API_KEYS: JSON.stringify({ qgent: AGENT_KEY, other: OTHER_KEY }),
  ...over,
});

function clock(start = T0) {
  let t = start;
  return { now: () => t, advance: (s: number) => { t += s; } };
}

async function call(
  method: string, path: string, deps: { fetchImpl: typeof fetch; now: () => number },
  o: { key?: string | null; body?: unknown; envOver?: Record<string, unknown> } = {},
) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const key = o.key === undefined ? AGENT_KEY : o.key;
  if (key) headers.Authorization = `Bearer ${key}`;
  const req = new Request(`https://qbase.test${path}`, {
    method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body),
  });
  const res = await handleAgentApprovalRoutes(req, testEnv(o.envOver), deps);
  return { res: res!, body: res ? await res.json().catch(() => null) as Record<string, any> : null };
}

async function draftAndPublish(deps: { fetchImpl: typeof fetch; now: () => number }, key = AGENT_KEY) {
  const d = await call('POST', '/api/agent/waves/drafts', deps, { key, body: { question_id: Q, wave: { closes_in_h: 24 } } });
  expect(d.res.status).toBe(201);
  const p = await call('POST', `/api/agent/waves/${d.body!.draft_id}/publish`, deps, { key });
  expect(p.res.status).toBe(202);
  return { draftId: d.body!.draft_id as string, approvalId: p.body!.approval_id as string, publish: p.body! };
}

const status = (approvalId: string, deps: { fetchImpl: typeof fetch; now: () => number }, key = AGENT_KEY) =>
  call('GET', `/api/agent/approvals/${approvalId}`, deps, { key });

async function draftStatus(draftId: string) {
  return (await env.DB.prepare('SELECT status FROM agent_wave_drafts WHERE id = ?').bind(draftId).first() as { status: string }).status;
}

describe('World ID for Agents approval gate', () => {
  beforeAll(async () => {
    KEY = await rsaKey('kid-1');
    IMPOSTOR = await rsaKey('kid-1'); // same kid, different key
    await env.DB.batch([
      env.DB.prepare('CREATE TABLE IF NOT EXISTS queries (id TEXT PRIMARY KEY, stem TEXT)'),
      env.DB.prepare('CREATE TABLE IF NOT EXISTS Answers (id TEXT PRIMARY KEY, q_id TEXT, user_id INTEGER, value TEXT, poll_id TEXT)'),
    ]);
    const exists = await env.DB.prepare("SELECT 1 FROM sqlite_master WHERE name = 'agent_approvals'").first();
    if (!exists) {
      const sql = migration.replace(/--.*$/gm, '');
      await env.DB.batch(sql.split(';').map(s => s.trim()).filter(Boolean).map(s => env.DB.prepare(s)));
    }
  });

  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM agent_approvals'), env.DB.prepare('DELETE FROM agent_owners'),
      env.DB.prepare('DELETE FROM agent_wave_drafts'), env.DB.prepare('DELETE FROM queries'), env.DB.prepare('DELETE FROM Answers'),
      env.DB.prepare("INSERT INTO queries (id, stem) VALUES (?, 'Q?')").bind(Q),
    ]);
  });

  // ── ID token ────────────────────────────────────────────────────────────

  describe('ID token validation', () => {
    const opts = () => ({ issuer: ISSUER, audience: CLIENT_ID, jwks: { keys: [KEY.jwk] }, notBefore: T0, now: T0 + 60 });
    const code = async (p: Promise<unknown>) => p.then(() => 'ok', (e: IdpError) => e.code);

    it('accepts a valid token', async () => {
      const c = await verifyIdToken(await sign(claims()), opts());
      expect(c.sub).toBe('human-owner');
    });
    it('rejects a wrong issuer', async () => {
      expect(await code(verifyIdToken(await sign(claims({ iss: 'https://evil.test' })), opts()))).toBe('wrong_issuer');
    });
    it('rejects a wrong audience, and a multi-audience token without our azp', async () => {
      expect(await code(verifyIdToken(await sign(claims({ aud: 'someone_else' })), opts()))).toBe('wrong_audience');
      expect(await code(verifyIdToken(await sign(claims({ aud: [CLIENT_ID, 'x'], azp: 'x' })), opts()))).toBe('wrong_audience');
      expect(await code(verifyIdToken(await sign(claims({ aud: [CLIENT_ID, 'x'], azp: CLIENT_ID })), opts()))).toBe('ok');
    });
    it('rejects an expired token', async () => {
      expect(await code(verifyIdToken(await sign(claims({ exp: T0 - 120 })), opts()))).toBe('expired');
    });
    it('rejects auth_time from before the approval was requested, and a missing auth_time', async () => {
      expect(await code(verifyIdToken(await sign(claims({ auth_time: T0 - 3600 })), opts()))).toBe('stale_auth');
      expect(await code(verifyIdToken(await sign(claims({ auth_time: undefined })), opts()))).toBe('no_auth_time');
    });
    it('does not take freshness from iat', async () => {
      expect(await code(verifyIdToken(await sign(claims({ iat: T0 + 30, auth_time: T0 - 3600 })), opts()))).toBe('stale_auth');
    });
    it('rejects a bad signature (a different key under the same kid)', async () => {
      expect(await code(verifyIdToken(await sign(claims(), IMPOSTOR), opts()))).toBe('bad_signature');
    });
    it('rejects a tampered payload', async () => {
      const [h, , s] = (await sign(claims())).split('.');
      const forged = `${h}.${b64url(JSON.stringify(claims({ sub: 'attacker' })))}.${s}`;
      expect(await code(verifyIdToken(forged, opts()))).toBe('bad_signature');
    });
    it('rejects alg none and HS256', async () => {
      const p = b64url(JSON.stringify(claims()));
      expect(await code(verifyIdToken(`${b64url(JSON.stringify({ alg: 'none' }))}.${p}.`, opts()))).toBe('unsupported_alg');
      expect(await code(verifyIdToken(await sign(claims(), KEY, { alg: 'HS256' }), opts()))).toBe('unsupported_alg');
    });
    it('rejects an unknown kid', async () => {
      expect(await code(verifyIdToken(await sign(claims(), KEY, { kid: 'kid-9' }), opts()))).toBe('unknown_key');
    });
  });

  // ── State machine (pure) ────────────────────────────────────────────────

  describe('polling state machine', () => {
    it('classifies RFC 8628 token responses', () => {
      expect(classifyTokenResponse(400, { error: 'authorization_pending' })).toEqual({ kind: 'pending' });
      expect(classifyTokenResponse(400, { error: 'slow_down' })).toEqual({ kind: 'slow_down' });
      expect(classifyTokenResponse(400, { error: 'access_denied' })).toMatchObject({ kind: 'stop', status: 'denied' });
      expect(classifyTokenResponse(400, { error: 'expired_token' })).toMatchObject({ kind: 'stop', status: 'expired' });
      expect(classifyTokenResponse(400, { error: 'invalid_grant' })).toMatchObject({ kind: 'stop', status: 'failed', reason: 'invalid_grant' });
      expect(classifyTokenResponse(503, {})).toMatchObject({ kind: 'stop', status: 'failed', reason: 'idp_unavailable' });
      expect(classifyTokenResponse(200, { id_token: 'a.b.c' })).toEqual({ kind: 'token', idToken: 'a.b.c' });
      expect(classifyTokenResponse(200, {})).toMatchObject({ kind: 'stop', reason: 'no_id_token' });
    });

    it('slow_down adds 5 s to every later poll, cumulatively', () => {
      const s1 = nextState({ interval_s: 5 }, { kind: 'slow_down' }, 100);
      expect(s1).toEqual({ status: 'pending', interval_s: 10, next_poll_at: 110 });
      const s2 = nextState({ interval_s: 10 }, { kind: 'slow_down' }, 110);
      expect(s2).toEqual({ status: 'pending', interval_s: 15, next_poll_at: 125 });
      const s3 = nextState({ interval_s: 15 }, { kind: 'pending' } as Exclude<TokenOutcome, { kind: 'token' }>, 125);
      expect(s3).toEqual({ status: 'pending', interval_s: 15, next_poll_at: 140 });
    });
  });

  // ── End to end against the mocked IdP ───────────────────────────────────

  describe('approval flow', () => {
    it('success: the owner approves, the token is validated, the draft is approved and the owner bound', async () => {
      const idp = mockIdp(); const c = clock(); const deps = { fetchImpl: idp.fetchImpl, now: c.now };
      const { draftId, approvalId, publish } = await draftAndPublish(deps);

      expect(publish).toMatchObject({ status: 'pending', user_code: 'ABCD-0001', verification_uri_complete: `${ISSUER}/device?user_code=ABCD-0001` });
      expect(JSON.stringify(publish)).not.toContain('DEVICE-CODE');

      // Confidential client: Basic auth, scope=openid, no secret in the body.
      const da = idp.calls.find(x => x.url.endsWith('/device_authorization'))!;
      expect(da.auth).toBe(`Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`);
      expect(Object.fromEntries(new URLSearchParams(da.body))).toEqual({ scope: 'openid' });

      idp.tokenQueue.push(pending);
      c.advance(5);
      expect((await status(approvalId, deps)).body!.status).toBe('pending');

      idp.tokenQueue.push(tokenReply(await sign(claims({}, c.now() + 3))));
      c.advance(5);
      const done = await status(approvalId, deps);
      expect(done.body).toMatchObject({ status: 'approved', draft_status: 'approved' });
      expect(done.body!.user_code).toBeUndefined();

      const tc = idp.tokenCalls();
      expect(tc).toHaveLength(2);
      expect(tc[0].auth).toMatch(/^Basic /);
      expect(Object.fromEntries(new URLSearchParams(tc[0].body))).toEqual({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: 'DEVICE-CODE-SECRET-1',
      });
      expect(await draftStatus(draftId)).toBe('approved');
      expect(await env.DB.prepare('SELECT iss, sub FROM agent_owners WHERE agent_id = ?').bind('qgent').first())
        .toEqual({ iss: ISSUER, sub: 'human-owner' });
    });

    it('respects the interval: reads before next_poll_at make no token call; concurrent reads poll once', async () => {
      const idp = mockIdp(); const c = clock(); const deps = { fetchImpl: idp.fetchImpl, now: c.now };
      const { approvalId } = await draftAndPublish(deps);
      await status(approvalId, deps);
      c.advance(3);
      await status(approvalId, deps);
      expect(idp.tokenCalls()).toHaveLength(0);

      c.advance(2);
      idp.tokenQueue.push(pending, pending);
      await Promise.all([status(approvalId, deps), status(approvalId, deps), status(approvalId, deps)]);
      expect(idp.tokenCalls()).toHaveLength(1);
    });

    it('slow_down is persisted: later polls wait the longer interval', async () => {
      const idp = mockIdp(); const c = clock(); const deps = { fetchImpl: idp.fetchImpl, now: c.now };
      const { approvalId } = await draftAndPublish(deps);
      idp.tokenQueue.push(slowDown);
      c.advance(5);
      await status(approvalId, deps);
      const row = await env.DB.prepare('SELECT interval_s, next_poll_at FROM agent_approvals WHERE id = ?').bind(approvalId).first();
      expect(row).toEqual({ interval_s: 10, next_poll_at: T0 + 15 });

      c.advance(5); // 10 s after the slow_down poll would be T0+15; at T0+10 nothing is due
      await status(approvalId, deps);
      expect(idp.tokenCalls()).toHaveLength(1);
      idp.tokenQueue.push(pending);
      c.advance(5);
      await status(approvalId, deps);
      expect(idp.tokenCalls()).toHaveLength(2);
    });

    const stops: Array<[string, { status: number; body: Record<string, unknown> }, string, string]> = [
      ['deny', { status: 400, body: { error: 'access_denied' } }, 'denied', 'access_denied'],
      ['IdP expiry', { status: 400, body: { error: 'expired_token' } }, 'expired', 'expired_token'],
      ['invalid_grant', { status: 400, body: { error: 'invalid_grant' } }, 'failed', 'invalid_grant'],
      ['503', { status: 503, body: {} }, 'failed', 'idp_unavailable'],
    ];
    for (const [name, reply, want, reason] of stops) {
      it(`${name}: stops, the draft stays a draft, no further polls`, async () => {
        const idp = mockIdp(); const c = clock(); const deps = { fetchImpl: idp.fetchImpl, now: c.now };
        const { draftId, approvalId } = await draftAndPublish(deps);
        idp.tokenQueue.push(reply);
        c.advance(5);
        expect((await status(approvalId, deps)).body).toMatchObject({ status: want, reason, draft_status: 'draft' });
        c.advance(60);
        await status(approvalId, deps);
        expect(idp.tokenCalls()).toHaveLength(1);
        expect(await draftStatus(draftId)).toBe('draft');
      });
    }

    it('expires locally after 20 minutes without asking the IdP', async () => {
      const idp = mockIdp(); const c = clock(); const deps = { fetchImpl: idp.fetchImpl, now: c.now };
      const { approvalId, publish } = await draftAndPublish(deps);
      expect(publish.expires_at).toBe(T0 + MAX_ATTEMPT_S); // IdP said 1800 s, bounded to 1200
      c.advance(MAX_ATTEMPT_S);
      expect((await status(approvalId, deps)).body).toMatchObject({ status: 'expired', reason: 'expired_local' });
      expect(idp.tokenCalls()).toHaveLength(0);
    });

    it('an invalid ID token (stale auth_time) refuses the approval', async () => {
      const idp = mockIdp(); const c = clock(); const deps = { fetchImpl: idp.fetchImpl, now: c.now };
      const { draftId, approvalId } = await draftAndPublish(deps);
      idp.tokenQueue.push(tokenReply(await sign(claims({ auth_time: T0 - 3600 }))));
      c.advance(5);
      expect((await status(approvalId, deps)).body).toMatchObject({ status: 'invalid_token', reason: 'stale_auth' });
      expect(await draftStatus(draftId)).toBe('draft');
      expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM agent_owners').first()).toEqual({ n: 0 });
    });

    it('a network error keeps the approval pending and retries at the next interval', async () => {
      const idp = mockIdp(); const c = clock(); const deps = { fetchImpl: idp.fetchImpl, now: c.now };
      const { approvalId } = await draftAndPublish(deps);
      idp.tokenQueue.push(async () => { throw new TypeError('network down'); });
      c.advance(5);
      expect((await status(approvalId, deps)).body!.status).toBe('pending');
      idp.tokenQueue.push(pending);
      c.advance(5);
      await status(approvalId, deps);
      expect(idp.tokenCalls()).toHaveLength(2);
    });
  });

  // ── Owner binding ───────────────────────────────────────────────────────

  describe('owner binding', () => {
    it('the first approval binds; the same human approves again; a different human is refused', async () => {
      const idp = mockIdp(); const c = clock(); const deps = { fetchImpl: idp.fetchImpl, now: c.now };

      const a = await draftAndPublish(deps);
      idp.tokenQueue.push(tokenReply(await sign(claims({}, c.now() + 1))));
      c.advance(5);
      expect((await status(a.approvalId, deps)).body!.status).toBe('approved');

      const b = await draftAndPublish(deps);
      idp.tokenQueue.push(tokenReply(await sign(claims({}, c.now() + 1))));
      c.advance(5);
      expect((await status(b.approvalId, deps)).body!.status).toBe('approved');

      const w = await draftAndPublish(deps);
      idp.tokenQueue.push(tokenReply(await sign(claims({ sub: 'someone-else' }, c.now() + 1))));
      c.advance(5);
      expect((await status(w.approvalId, deps)).body).toMatchObject({ status: 'wrong_human', reason: 'not_the_owner', draft_status: 'draft' });
      expect(await draftStatus(w.draftId)).toBe('draft');
      expect(await env.DB.prepare('SELECT sub FROM agent_owners WHERE agent_id = ?').bind('qgent').first()).toEqual({ sub: 'human-owner' });
    });

    it('owners are per agent: another agent binds its own owner', async () => {
      const idp = mockIdp(); const c = clock(); const deps = { fetchImpl: idp.fetchImpl, now: c.now };
      const a = await draftAndPublish(deps);
      idp.tokenQueue.push(tokenReply(await sign(claims({}, c.now() + 1))));
      c.advance(5);
      await status(a.approvalId, deps);

      const o = await draftAndPublish(deps, OTHER_KEY);
      idp.tokenQueue.push(tokenReply(await sign(claims({ sub: 'other-owner' }, c.now() + 1))));
      c.advance(5);
      expect((await status(o.approvalId, deps, OTHER_KEY)).body!.status).toBe('approved');
    });
  });

  // ── Routes ──────────────────────────────────────────────────────────────

  describe('routes', () => {
    it('flag off: every agent route 404s', async () => {
      const idp = mockIdp(); const deps = { fetchImpl: idp.fetchImpl, now: clock().now };
      for (const [m, p] of [['POST', '/api/agent/waves/drafts'], ['POST', '/api/agent/waves/x/publish'], ['GET', '/api/agent/approvals/x']]) {
        const r = await call(m, p, deps, { envOver: { AGENT_APPROVAL_ENABLED: undefined }, body: m === 'POST' ? {} : undefined });
        expect(r.res.status).toBe(404);
      }
      expect(idp.calls).toHaveLength(0);
    });

    it('no key or a wrong key: 401', async () => {
      const deps = { fetchImpl: mockIdp().fetchImpl, now: clock().now };
      expect((await call('POST', '/api/agent/waves/drafts', deps, { key: null, body: { question_id: Q } })).res.status).toBe(401);
      expect((await call('POST', '/api/agent/waves/drafts', deps, { key: 'nope-nope-nope-nope-nope', body: { question_id: Q } })).res.status).toBe(401);
    });

    it('IdP not configured: 503', async () => {
      const deps = { fetchImpl: mockIdp().fetchImpl, now: clock().now };
      const r = await call('POST', '/api/agent/waves/drafts', deps, { body: { question_id: Q }, envOver: { WORLD_IDP_CLIENT_SECRET: undefined } });
      expect(r.res.status).toBe(503);
    });

    it('forged approval: an agent cannot post a status; only redemption changes it', async () => {
      const idp = mockIdp(); const c = clock(); const deps = { fetchImpl: idp.fetchImpl, now: c.now };
      const { draftId, approvalId } = await draftAndPublish(deps);
      const forged = await call('POST', `/api/agent/approvals/${approvalId}`, deps, { body: { status: 'approved', id_token: 'x.y.z' } });
      expect(forged.res.status).toBe(405);
      expect((await status(approvalId, deps)).body!.status).toBe('pending');
      expect(await draftStatus(draftId)).toBe('draft');
    });

    it('re-requesting publish while pending returns the same code; after approval it is 409', async () => {
      const idp = mockIdp(); const c = clock(); const deps = { fetchImpl: idp.fetchImpl, now: c.now };
      const { draftId, approvalId } = await draftAndPublish(deps);
      const again = await call('POST', `/api/agent/waves/${draftId}/publish`, deps);
      expect(again.res.status).toBe(200);
      expect(again.body).toMatchObject({ approval_id: approvalId, user_code: 'ABCD-0001' });
      expect(idp.calls.filter(x => x.url.endsWith('/device_authorization'))).toHaveLength(1);

      idp.tokenQueue.push(tokenReply(await sign(claims({}, c.now() + 1))));
      c.advance(5);
      await status(approvalId, deps);
      expect((await call('POST', `/api/agent/waves/${draftId}/publish`, deps)).res.status).toBe(409);
    });

    it('after a deny the agent may ask again with a fresh code', async () => {
      const idp = mockIdp(); const c = clock(); const deps = { fetchImpl: idp.fetchImpl, now: c.now };
      const { draftId, approvalId } = await draftAndPublish(deps);
      idp.tokenQueue.push({ status: 400, body: { error: 'access_denied' } });
      c.advance(5);
      await status(approvalId, deps);
      const again = await call('POST', `/api/agent/waves/${draftId}/publish`, deps);
      expect(again.res.status).toBe(202);
      expect(again.body!.approval_id).not.toBe(approvalId);
      expect(again.body!.user_code).toBe('ABCD-0002');
    });

    it("an agent cannot see or publish another agent's draft", async () => {
      const deps = { fetchImpl: mockIdp().fetchImpl, now: clock().now };
      const { draftId, approvalId } = await draftAndPublish(deps);
      expect((await call('POST', `/api/agent/waves/${draftId}/publish`, deps, { key: OTHER_KEY })).res.status).toBe(404);
      expect((await status(approvalId, deps, OTHER_KEY)).res.status).toBe(404);
    });

    it('drafts need an existing question', async () => {
      const deps = { fetchImpl: mockIdp().fetchImpl, now: clock().now };
      expect((await call('POST', '/api/agent/waves/drafts', deps, { body: { question_id: 'nope' } })).res.status).toBe(404);
      expect((await call('POST', '/api/agent/waves/drafts', deps, { body: {} })).res.status).toBe(400);
    });

    it('no agent route writes an answer; answer-shaped paths are not handled here', async () => {
      const idp = mockIdp(); const c = clock(); const deps = { fetchImpl: idp.fetchImpl, now: c.now };
      for (const p of ['/api/agent/answers', `/api/agent/waves/x/answer`, '/api/agent/approvals/x/answer']) {
        const req = new Request(`https://qbase.test${p}`, { method: 'POST', headers: { Authorization: `Bearer ${AGENT_KEY}` }, body: '{}' });
        expect(await handleAgentApprovalRoutes(req, testEnv(), deps)).toBeNull();
      }
      const { approvalId } = await draftAndPublish(deps);
      idp.tokenQueue.push(tokenReply(await sign(claims({}, c.now() + 1))));
      c.advance(5);
      await status(approvalId, deps);
      expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM Answers').first()).toEqual({ n: 0 });
    });
  });

  describe('device code at rest', () => {
    it('is stored sealed, bound to its approval id', async () => {
      const deps = { fetchImpl: mockIdp().fetchImpl, now: clock().now };
      const { approvalId } = await draftAndPublish(deps);
      const row = await env.DB.prepare('SELECT * FROM agent_approvals WHERE id = ?').bind(approvalId).first() as Record<string, string>;
      expect(JSON.stringify(row)).not.toContain('DEVICE-CODE');
      expect(await openDeviceCode(CFG, approvalId, row.device_code_ct)).toBe('DEVICE-CODE-SECRET-1');
      await expect(openDeviceCode(CFG, 'another-id', row.device_code_ct)).rejects.toThrow();
      await expect(openDeviceCode({ ...CFG, clientSecret: 'other' }, approvalId, row.device_code_ct)).rejects.toThrow();
      const sealed = await sealDeviceCode(CFG, 'a', 'x');
      expect(sealed).not.toBe(await sealDeviceCode(CFG, 'a', 'x'));
    });
  });
});
