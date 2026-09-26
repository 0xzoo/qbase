/**
 * Account sign-in methods and credential linking (docs/specs/account-root.md §6.2).
 *
 *   GET    /api/auth/methods                     which sign-in methods are live
 *   GET    /api/auth/siwe/nonce                  single-use SIWE nonce (5 min)
 *   POST   /api/auth/siwe/verify                 { message, signature, link? } → session, or link to the signed-in account
 *   POST   /api/auth/world/start                 { link?, returnTo? } → { url } of the World IdP
 *   GET    /api/auth/world/callback              IdP redirect target → back to the app with a session (or linked)
 *   GET    /api/account/credentials              the signed-in account's sign-in methods
 *   DELETE /api/account/credentials/:kind/:value remove one (not the last, not Farcaster)
 *   POST   /api/account/link/farcaster           { message, signature, nonce } (SIWF) → link a fid
 *
 * All of it is refused (503 accounts_not_ready) until the account cutover has
 * run: before it there is no key for a person without a fid.
 */

import { RateLimitService } from '../services/RateLimitService';
import { AuthService } from '../services/AuthService';
import { requireFlexibleAuth } from '../middleware/auth';
import {
  isRewritten, accountForCredential, createAccount, touchCredential, linkCredential, unlinkCredential,
  listCredentials, AccountError, type CredentialKind,
} from '../services/accounts/AccountService';
import { issueNonce, verifySiwe, SiweError } from '../services/accounts/SiweLogin';
import { worldConfig, startWorldLogin, finishWorldLogin, WorldLoginError } from '../services/accounts/WorldLogin';
import { seedHandle } from '../services/accounts/HandleService';
import { initFarcasterData } from '../services/farcaster';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

const SESSION_TTL_S = 7 * 24 * 60 * 60;
const KINDS: CredentialKind[] = ['farcaster', 'passkey', 'ethereum', 'world'];

async function rateGate(request: Request, env: Env, endpoint: string, limit: number): Promise<Response | null> {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const allowed = await RateLimitService.fromEnv(env).checkLimit(ip, limit, 60, endpoint);
  return allowed ? null : new Response('Too Many Requests', { status: 429 });
}

export async function createAccountSession(env: Env, accountId: number, via: string): Promise<{ sessionToken: string; expiresAt: number }> {
  const sessionToken = crypto.randomUUID();
  const expiresAt = Date.now() + SESSION_TTL_S * 1000;
  await env.KV_USER_PROFILES.put(`session:${sessionToken}`, JSON.stringify({ accountId, via, expiresAt }), { expirationTtl: SESSION_TTL_S });
  return { sessionToken, expiresAt };
}

const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** A same-origin path to send the browser back to; anything else becomes "/". */
function safeReturn(raw: unknown): string {
  return typeof raw === 'string' && raw.startsWith('/') && !raw.startsWith('//') ? raw : '/';
}

function errorResponse(e: unknown): Response {
  if (e instanceof AccountError) return Response.json({ error: e.code }, { status: e.status });
  if (e instanceof SiweError || e instanceof WorldLoginError) return Response.json({ error: e.code }, { status: 401 });
  console.error('[account] failed:', e);
  return Response.json({ error: 'internal_error' }, { status: 500 });
}

export async function handleAccountRoutes(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const { pathname } = url;
  const method = request.method;
  const isOurs = pathname === '/api/auth/methods' || pathname.startsWith('/api/auth/siwe/') || pathname.startsWith('/api/auth/world/') || pathname.startsWith('/api/account/');
  if (!isOurs) return null;

  try {
    const ready = await isRewritten(env);

    if (pathname === '/api/auth/methods' && method === 'GET') {
      return Response.json({ ethereum: ready, world: ready && worldConfig(env, request.url) !== null });
    }
    if (!ready) return Response.json({ error: 'accounts_not_ready' }, { status: 503 });

    // ── Sign-In with Ethereum ───────────────────────────────────────────────
    if (pathname === '/api/auth/siwe/nonce' && method === 'GET') {
      const limited = await rateGate(request, env, 'auth:siwe:nonce', 60);
      if (limited) return limited;
      return Response.json({ nonce: await issueNonce(env) });
    }
    if (pathname === '/api/auth/siwe/verify' && method === 'POST') {
      const limited = await rateGate(request, env, 'auth:siwe:verify', 10);
      if (limited) return limited;
      const body = await request.json().catch(() => ({})) as { message?: string; signature?: `0x${string}`; link?: boolean };
      const { address, ensName } = await verifySiwe(env, request.url, body.message ?? '', body.signature ?? '0x');
      if (body.link) {
        const auth = await requireFlexibleAuth(request, env);
        if (!auth.authenticated || auth.accountId === undefined) return Response.json({ error: 'unauthorized' }, { status: 401 });
        await linkCredential(env, auth.accountId, 'ethereum', address, ensName);
        if (ensName) await seedHandle(env, auth.accountId, ensName);
        return Response.json({ linked: 'ethereum', address, ensName });
      }
      let accountId = await accountForCredential(env, 'ethereum', address);
      if (accountId === undefined) {
        accountId = (await createAccount(env, { kind: 'ethereum', value: address, label: ensName, fname: ensName ?? shortAddress(address), displayName: ensName })).accountId;
      } else {
        await touchCredential(env, 'ethereum', address, ensName);
        if (ensName) {
          await env.DB.prepare(`UPDATE Users SET fname = ?, display_name = ? WHERE fid = ? AND profile_source = 'ethereum'`).bind(ensName, ensName, accountId).run();
        }
      }
      // A verified ENS name is a handle the person proved; only taken when free and none is set.
      if (ensName) await seedHandle(env, accountId, ensName);
      const session = await createAccountSession(env, accountId, 'ethereum');
      return Response.json({ ...session, accountId, address, ensName });
    }

    // ── World ID ────────────────────────────────────────────────────────────
    if (pathname === '/api/auth/world/start' && method === 'POST') {
      const cfg = worldConfig(env, request.url);
      if (!cfg) return Response.json({ error: 'world_login_unconfigured' }, { status: 503 });
      const limited = await rateGate(request, env, 'auth:world:start', 20);
      if (limited) return limited;
      const body = await request.json().catch(() => ({})) as { link?: boolean; returnTo?: string };
      let linkAccountId: number | null = null;
      if (body.link) {
        const auth = await requireFlexibleAuth(request, env);
        if (!auth.authenticated || auth.accountId === undefined) return Response.json({ error: 'unauthorized' }, { status: 401 });
        linkAccountId = auth.accountId;
      }
      return Response.json({ url: await startWorldLogin(env, cfg, { linkAccountId, returnTo: safeReturn(body.returnTo) }) });
    }
    if (pathname === '/api/auth/world/callback' && method === 'GET') {
      const cfg = worldConfig(env, request.url);
      if (!cfg) return Response.json({ error: 'world_login_unconfigured' }, { status: 503 });
      const back = (path: string, frag: Record<string, string>) =>
        Response.redirect(`${url.origin}${path}#${new URLSearchParams(frag).toString()}`, 302);
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      if (!code || !state) return back('/', { auth_error: url.searchParams.get('error') ?? 'missing_code' });
      try {
        const { credential, pending } = await finishWorldLogin(env, cfg, code, state);
        if (pending.linkAccountId !== null) {
          // A refused link goes back to where it started (Settings) with the
          // reason, not to the home page, where nothing shows it.
          try {
            await linkCredential(env, pending.linkAccountId, 'world', credential);
          } catch (e) {
            if (e instanceof AccountError) return back(pending.returnTo, { auth_error: e.code });
            throw e;
          }
          return back(pending.returnTo, { linked: 'world' });
        }
        let accountId = await accountForCredential(env, 'world', credential);
        if (accountId === undefined) {
          accountId = (await createAccount(env, { kind: 'world', value: credential, label: 'World ID', fname: null, displayName: null })).accountId;
        } else {
          await touchCredential(env, 'world', credential);
        }
        const session = await createAccountSession(env, accountId, 'world');
        return back(pending.returnTo, { qbase_session: session.sessionToken, expires_at: String(session.expiresAt) });
      } catch (e) {
        const code2 = e instanceof WorldLoginError || e instanceof AccountError ? e.code : 'internal_error';
        if (!(e instanceof WorldLoginError || e instanceof AccountError)) console.error('[account] world callback failed:', e);
        return back('/', { auth_error: code2 });
      }
    }

    // ── Credentials on the signed-in account ────────────────────────────────
    const auth = await requireFlexibleAuth(request, env);
    if (!auth.authenticated || auth.accountId === undefined) return Response.json({ error: 'unauthorized' }, { status: 401 });

    if (pathname === '/api/account/credentials' && method === 'GET') {
      const creds = await listCredentials(env, auth.accountId);
      return Response.json({
        accountId: auth.accountId,
        credentials: creds.map(c => ({ kind: c.kind, value: c.kind === 'world' ? 'World ID' : c.value, label: c.label, created_at: c.created_at, last_used_at: c.last_used_at, id: `${c.kind}:${c.value}` })),
      });
    }
    const del = pathname.match(/^\/api\/account\/credentials\/([a-z]+)\/(.+)$/);
    if (del && method === 'DELETE') {
      const kind = del[1] as CredentialKind;
      if (!KINDS.includes(kind)) return Response.json({ error: 'unknown_kind' }, { status: 400 });
      await unlinkCredential(env, auth.accountId, kind, decodeURIComponent(del[2]));
      return Response.json({ removed: `${kind}` });
    }
    if (pathname === '/api/account/link/farcaster' && method === 'POST') {
      const limited = await rateGate(request, env, 'auth:link:farcaster', 10);
      if (limited) return limited;
      const body = await request.json().catch(() => ({})) as { message?: string; signature?: `0x${string}`; nonce?: string };
      if (!body.message || !body.signature || !body.nonce) return Response.json({ error: 'invalid_request' }, { status: 400 });
      const nonceKey = `siwf_nonce:${body.nonce}`;
      if (!(await env.KV_USER_PROFILES.get(nonceKey))) return Response.json({ error: 'nonce_expired' }, { status: 401 });
      await env.KV_USER_PROFILES.delete(nonceKey);
      const r = await AuthService.fromEnv(env, request.url).verifySIWFMessage({ message: body.message, signature: body.signature, nonce: body.nonce });
      if (!r.success || !r.fid) return Response.json({ error: r.error || 'invalid_credentials' }, { status: 401 });
      await linkCredential(env, auth.accountId, 'farcaster', r.fid);
      // An account without a handle takes its fname (when free); one that has a handle keeps it.
      try {
        const fcUser = await initFarcasterData(env).getUser(r.fid);
        if (fcUser?.username) await seedHandle(env, auth.accountId, fcUser.username);
      } catch (err) {
        console.warn('[account] fname lookup after link failed:', err);
      }
      return Response.json({ linked: 'farcaster', fid: r.fid });
    }
    return Response.json({ error: 'not_found' }, { status: 404 });
  } catch (e) {
    return errorResponse(e);
  }
}
