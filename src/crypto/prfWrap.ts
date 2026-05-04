/**
 * Wrap and unwrap an Ed448 private key with a key derived from a WebAuthn
 * PRF extension result. The PRF output is hardware-backed by the user's
 * authenticator; the AES key derived from it never exists outside this
 * function's stack and the AES-GCM `encrypt`/`decrypt` calls.
 *
 * Salt is static so the PRF eval can be requested during a discoverable
 * ceremony (where we don't know the credentialId yet). The PRF output is
 * already per-credential, so a static salt + per-credential PRF output is
 * sufficient to give each credential its own key.
 *
 * Browser support (as of 2026-05): Chrome/Edge ≥ 132, Safari ≥ 18,
 * Firefox is in development behind a flag. When PRF isn't available the
 * caller falls back to plaintext storage (no silent encryption pretence).
 */

const HKDF_INFO = new TextEncoder().encode('qbase-passkey-ed448-wrap-v1');

// SHA-256("qbase-passkey-prf-salt-v1") — static, app-scoped salt.
// Computed at import time so we don't pull in @noble/hashes for one constant.
let prfSaltCache: Uint8Array | null = null;
async function getPrfSalt(): Promise<Uint8Array> {
  if (prfSaltCache) return prfSaltCache;
  const data = new TextEncoder().encode('qbase-passkey-prf-salt-v1');
  const hash = await crypto.subtle.digest('SHA-256', data);
  prfSaltCache = new Uint8Array(hash);
  return prfSaltCache;
}

/**
 * Build the `prf.eval` parameter for `navigator.credentials.{create,get}`.
 * Always returns an `{ eval: { first } }` shape — callers don't need to
 * branch on browser support; the PRF result will simply be absent on
 * unsupporting browsers.
 */
export async function getPrfEvalParams(): Promise<{ first: ArrayBuffer }> {
  const salt = await getPrfSalt();
  return { first: salt.buffer.slice(salt.byteOffset, salt.byteOffset + salt.byteLength) };
}

async function deriveAesKey(prfOutput: ArrayBuffer): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey('raw', prfOutput, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: HKDF_INFO },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function wrapPrivateKey(
  privateKey: Uint8Array,
  prfOutput: ArrayBuffer,
): Promise<{ ciphertext: string; iv: string }> {
  const aes = await deriveAesKey(prfOutput);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, privateKey);
  return {
    ciphertext: bytesToBase64(new Uint8Array(ct)),
    iv: bytesToBase64(iv),
  };
}

export async function unwrapPrivateKey(
  ciphertextB64: string,
  ivB64: string,
  prfOutput: ArrayBuffer,
): Promise<Uint8Array> {
  const aes = await deriveAesKey(prfOutput);
  const iv = base64ToBytes(ivB64);
  const ct = base64ToBytes(ciphertextB64);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aes, ct);
  return new Uint8Array(pt);
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
