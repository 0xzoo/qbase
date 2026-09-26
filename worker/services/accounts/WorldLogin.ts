/**
 * Sign in with World ID through the World IdP (OIDC authorization code +
 * PKCE, confidential client) — docs/specs/account-root.md §6.2.
 *
 * The credential is `<iss>|<sub>`: `sub` is stable per person for this client
 * and reveals nothing else. Disabled until WORLD_IDP_ISSUER,
 * WORLD_IDP_CLIENT_ID and WORLD_IDP_CLIENT_SECRET exist.
 *
 * ID token checks: issuer, audience, signature against the issuer's JWKS
 * (RS256 or ES256), expiry, and `auth_time` freshness (never `iat`).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

const STATE_TTL_S = 600;
const MAX_AUTH_AGE_S = 600;

export class WorldLoginError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

export interface WorldConfig { issuer: string; clientId: string; clientSecret: string; redirectUri: string }

export function worldConfig(env: Env, requestUrl: string): WorldConfig | null {
  const issuer = typeof env?.WORLD_IDP_ISSUER === 'string' ? env.WORLD_IDP_ISSUER.replace(/\/$/, '') : '';
  const clientId = typeof env?.WORLD_IDP_CLIENT_ID === 'string' ? env.WORLD_IDP_CLIENT_ID : '';
  const clientSecret = typeof env?.WORLD_IDP_CLIENT_SECRET === 'string' ? env.WORLD_IDP_CLIENT_SECRET : '';
  if (!issuer || !clientId || !clientSecret) return null;
  const origin = new URL(requestUrl).origin;
  return { issuer, clientId, clientSecret, redirectUri: `${origin}/api/auth/world/callback` };
}

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function b64urlDecode(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

interface Discovery { authorization_endpoint: string; token_endpoint: string; jwks_uri: string; issuer: string }
const discoveryCache = new Map<string, Promise<Discovery>>();
async function discover(issuer: string): Promise<Discovery> {
  let p = discoveryCache.get(issuer);
  if (!p) {
    p = fetch(`${issuer}/.well-known/openid-configuration`).then(async r => {
      if (!r.ok) throw new WorldLoginError('discovery_failed');
      return r.json() as Promise<Discovery>;
    });
    discoveryCache.set(issuer, p);
    p.catch(() => discoveryCache.delete(issuer));
  }
  return p;
}

export interface PendingLogin { verifier: string; nonce: string; linkAccountId: number | null; returnTo: string }

/** Start a login (or a link, when linkAccountId is set): returns the IdP authorization URL. */
export async function startWorldLogin(env: Env, cfg: WorldConfig, p: { linkAccountId: number | null; returnTo: string }): Promise<string> {
  const d = await discover(cfg.issuer);
  const state = b64url(crypto.getRandomValues(new Uint8Array(24)));
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const pending: PendingLogin = { verifier, nonce, linkAccountId: p.linkAccountId, returnTo: p.returnTo };
  await env.KV_USER_PROFILES.put(`world_login:${state}`, JSON.stringify(pending), { expirationTtl: STATE_TTL_S });
  const u = new URL(d.authorization_endpoint);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', cfg.clientId);
  u.searchParams.set('redirect_uri', cfg.redirectUri);
  u.searchParams.set('scope', 'openid');
  u.searchParams.set('state', state);
  u.searchParams.set('nonce', nonce);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  // Always authenticate afresh: a reused IdP session carries an old auth_time,
  // which the freshness check below rejects as stale_auth.
  u.searchParams.set('prompt', 'login');
  return u.toString();
}

/** Finish a login: exchange the code, validate the ID token. Returns the credential value and what was pending. */
export async function finishWorldLogin(env: Env, cfg: WorldConfig, code: string, state: string): Promise<{ credential: string; pending: PendingLogin }> {
  const key = `world_login:${state}`;
  const raw = await env.KV_USER_PROFILES.get(key);
  if (!raw) throw new WorldLoginError('state_expired');
  await env.KV_USER_PROFILES.delete(key);
  const pending = JSON.parse(raw) as PendingLogin;
  const d = await discover(cfg.issuer);
  const res = await fetch(d.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${btoa(`${encodeURIComponent(cfg.clientId)}:${encodeURIComponent(cfg.clientSecret)}`)}` },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: cfg.redirectUri, code_verifier: pending.verifier }),
  });
  if (!res.ok) throw new WorldLoginError('token_exchange_failed');
  const tok = await res.json() as { id_token?: string };
  if (!tok.id_token) throw new WorldLoginError('no_id_token');
  const claims = await verifyIdToken(tok.id_token, { issuer: d.issuer ?? cfg.issuer, audience: cfg.clientId, jwksUri: d.jwks_uri, nonce: pending.nonce });
  return { credential: `${claims.iss}|${claims.sub}`, pending };
}

export interface IdTokenClaims { iss: string; sub: string; aud: string | string[]; exp: number; auth_time?: number; nonce?: string }

/** Validate an ID token. Exported for tests (`jwks` can be passed directly). */
export async function verifyIdToken(
  token: string,
  o: { issuer: string; audience: string; jwksUri?: string; jwks?: { keys: JsonWebKey[] }; nonce?: string; now?: number },
): Promise<IdTokenClaims> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new WorldLoginError('malformed_token');
  const header = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[0]))) as { alg: string; kid?: string };
  const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1]))) as IdTokenClaims;
  const jwks: { keys: JsonWebKey[] } = o.jwks ?? await fetch(o.jwksUri!).then(r => r.json() as Promise<{ keys: JsonWebKey[] }>);
  const jwk = (jwks?.keys ?? []).find(k => !header.kid || (k as { kid?: string }).kid === header.kid);
  if (!jwk) throw new WorldLoginError('unknown_key');
  let algo: { name: string; hash?: string; namedCurve?: string };
  let verifyAlgo: { name: string; hash?: string };
  if (header.alg === 'RS256') { algo = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }; verifyAlgo = { name: 'RSASSA-PKCS1-v1_5' }; }
  else if (header.alg === 'ES256') { algo = { name: 'ECDSA', namedCurve: 'P-256' }; verifyAlgo = { name: 'ECDSA', hash: 'SHA-256' }; }
  else throw new WorldLoginError('unsupported_alg');
  const key = await crypto.subtle.importKey('jwk', jwk, algo, false, ['verify']);
  const ok = await crypto.subtle.verify(verifyAlgo, key, b64urlDecode(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) throw new WorldLoginError('bad_signature');
  const now = o.now ?? Math.floor(Date.now() / 1000);
  if (claims.iss !== o.issuer) throw new WorldLoginError('wrong_issuer');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(o.audience)) throw new WorldLoginError('wrong_audience');
  if (typeof claims.exp !== 'number' || claims.exp < now) throw new WorldLoginError('expired');
  if (typeof claims.auth_time === 'number' && now - claims.auth_time > MAX_AUTH_AGE_S) {
    console.warn('[world-login] stale_auth', { auth_time: claims.auth_time, now });
    throw new WorldLoginError('stale_auth');
  }
  if (o.nonce !== undefined && claims.nonce !== o.nonce) throw new WorldLoginError('wrong_nonce');
  if (typeof claims.sub !== 'string' || !claims.sub) throw new WorldLoginError('no_subject');
  return claims;
}
