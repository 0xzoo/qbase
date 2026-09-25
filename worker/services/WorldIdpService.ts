/**
 * World ID IdP (OIDC) client for the device authorization grant, RFC 8628
 * (plan §6.2). qbase is the confidential client: the secret stays in the
 * worker and authenticates with client_secret_basic, never in a body.
 *
 * Disabled until WORLD_IDP_ISSUER, WORLD_IDP_CLIENT_ID and
 * WORLD_IDP_CLIENT_SECRET exist (the same client World login will use).
 *
 * ID token checks: signature against the issuer's JWKS (RS256, the only alg
 * the IdP advertises), issuer, audience (+ azp when several), expiry, nbf,
 * and freshness via auth_time, which is required and must fall after the
 * approval was requested. Never iat; the device-grant token carries no nonce.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

export const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const CLOCK_SKEW_S = 60;

export class IdpError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

export interface IdpConfig { issuer: string; clientId: string; clientSecret: string }

export function idpConfig(env: Env): IdpConfig | null {
  const issuer = typeof env?.WORLD_IDP_ISSUER === 'string' ? env.WORLD_IDP_ISSUER.replace(/\/$/, '') : '';
  const clientId = typeof env?.WORLD_IDP_CLIENT_ID === 'string' ? env.WORLD_IDP_CLIENT_ID : '';
  const clientSecret = typeof env?.WORLD_IDP_CLIENT_SECRET === 'string' ? env.WORLD_IDP_CLIENT_SECRET : '';
  if (!issuer || !clientId || !clientSecret) return null;
  return { issuer, clientId, clientSecret };
}

export interface Discovery {
  issuer: string;
  token_endpoint: string;
  device_authorization_endpoint: string;
  jwks_uri: string;
}

export async function discover(cfg: IdpConfig, fetchImpl: typeof fetch = fetch): Promise<Discovery> {
  const res = await fetchImpl(`${cfg.issuer}/.well-known/openid-configuration`);
  if (!res.ok) throw new IdpError('discovery_failed');
  const d = await res.json() as Discovery;
  // OIDC Discovery §4.3: the document's issuer must be the one we asked.
  if (d.issuer !== cfg.issuer) throw new IdpError('discovery_issuer_mismatch');
  if (!d.token_endpoint || !d.device_authorization_endpoint || !d.jwks_uri) throw new IdpError('discovery_incomplete');
  return d;
}

/** RFC 6749 §2.3.1: form-encode id and secret, then Basic. */
function basicAuth(cfg: IdpConfig): string {
  const enc = (s: string) => encodeURIComponent(s).replace(/%20/g, '+');
  return `Basic ${btoa(`${enc(cfg.clientId)}:${enc(cfg.clientSecret)}`)}`;
}

export interface DeviceAuthorization {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

/** POST device_authorization with scope=openid (the only scope the device grant supports). */
export async function requestDeviceAuthorization(
  cfg: IdpConfig,
  d: Discovery,
  fetchImpl: typeof fetch = fetch,
): Promise<DeviceAuthorization> {
  const res = await fetchImpl(d.device_authorization_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: basicAuth(cfg) },
    body: new URLSearchParams({ scope: 'openid' }),
  });
  const body = await res.json().catch(() => ({})) as Partial<DeviceAuthorization> & { error?: string };
  if (!res.ok) throw new IdpError(`device_authorization_failed:${body.error ?? res.status}`);
  if (!body.device_code || !body.user_code || !body.verification_uri || typeof body.expires_in !== 'number') {
    throw new IdpError('device_authorization_incomplete');
  }
  return {
    device_code: body.device_code,
    user_code: body.user_code,
    verification_uri: body.verification_uri,
    verification_uri_complete: body.verification_uri_complete,
    expires_in: body.expires_in,
    // RFC 8628 §3.2: absent means 5 seconds.
    interval: typeof body.interval === 'number' && body.interval > 0 ? body.interval : 5,
  };
}

/** One token-endpoint call for a device code. Returns the raw HTTP status and JSON body for classification. */
export async function redeemDeviceCode(
  cfg: IdpConfig,
  d: Discovery,
  deviceCode: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetchImpl(d.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: basicAuth(cfg) },
    body: new URLSearchParams({ grant_type: DEVICE_CODE_GRANT, device_code: deviceCode }),
  });
  const body = await res.json().catch(() => ({})) as Record<string, unknown>;
  return { status: res.status, body };
}

// ── ID token ──────────────────────────────────────────────────────────────

function b64urlDecode(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

function decodeJson<T>(part: string): T {
  try {
    return JSON.parse(new TextDecoder().decode(b64urlDecode(part))) as T;
  } catch {
    throw new IdpError('malformed_token');
  }
}

export interface IdTokenClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  azp?: string;
  exp: number;
  nbf?: number;
  auth_time: number;
  acr?: string;
}

export interface VerifyIdTokenOptions {
  issuer: string;
  audience: string;
  jwks: { keys: JsonWebKey[] };
  /** The approval was requested at this time; the human must have authenticated after it. */
  notBefore: number;
  now: number;
}

/** Validate an ID token. Throws IdpError with a stable code; returns the claims. */
export async function verifyIdToken(token: string, o: VerifyIdTokenOptions): Promise<IdTokenClaims> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new IdpError('malformed_token');
  const header = decodeJson<{ alg?: string; kid?: string }>(parts[0]);
  const claims = decodeJson<IdTokenClaims>(parts[1]);

  if (header.alg !== 'RS256') throw new IdpError('unsupported_alg');
  const candidates = (o.jwks?.keys ?? []).filter(k => {
    const kk = k as JsonWebKey & { kid?: string; use?: string };
    return kk.kty === 'RSA' && (kk.use === undefined || kk.use === 'sig') && (!header.kid || kk.kid === header.kid);
  });
  if (candidates.length === 0) throw new IdpError('unknown_key');
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const sig = b64urlDecode(parts[2]);
  let ok = false;
  for (const jwk of candidates) {
    const { kid: _kid, use: _use, alg: _alg, key_ops: _ops, ...material } = jwk as JsonWebKey & { kid?: string; use?: string };
    const key = await crypto.subtle.importKey('jwk', material, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    if (await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, signed)) { ok = true; break; }
  }
  if (!ok) throw new IdpError('bad_signature');

  if (claims.iss !== o.issuer) throw new IdpError('wrong_issuer');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(o.audience)) throw new IdpError('wrong_audience');
  if (aud.length > 1 && claims.azp !== o.audience) throw new IdpError('wrong_audience');
  if (typeof claims.exp !== 'number' || claims.exp <= o.now - CLOCK_SKEW_S) throw new IdpError('expired');
  if (typeof claims.nbf === 'number' && claims.nbf > o.now + CLOCK_SKEW_S) throw new IdpError('not_yet_valid');
  if (typeof claims.sub !== 'string' || !claims.sub) throw new IdpError('no_subject');
  // Fresh means the human authenticated for this request, not earlier.
  if (typeof claims.auth_time !== 'number') throw new IdpError('no_auth_time');
  if (claims.auth_time < o.notBefore - CLOCK_SKEW_S || claims.auth_time > o.now + CLOCK_SKEW_S) {
    throw new IdpError('stale_auth');
  }
  return claims;
}

export async function fetchJwks(d: Discovery, fetchImpl: typeof fetch = fetch): Promise<{ keys: JsonWebKey[] }> {
  const res = await fetchImpl(d.jwks_uri);
  if (!res.ok) throw new IdpError('jwks_failed');
  return await res.json() as { keys: JsonWebKey[] };
}
