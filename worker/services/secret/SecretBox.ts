/**
 * SecretBox — worker-side envelope encryption for the Secret tier.
 *
 * Spec: docs/specs/private-answer-encryption.md §7 (design), §7.8 (rotation).
 *
 * What it does: seals bytes under a per-object data key (DEK, AES-256-GCM,
 * random 96-bit IV) and wraps that DEK under a key-encryption key (KEK) held
 * in the Worker secret `ANSWER_KEKS`. The context string `ctx` is the AAD for
 * both the body and the DEK wrap, so a sealed object is bound to its location,
 * tier and owner and cannot be swapped between answers. The reader recomputes
 * `ctx` from D1 and refuses a mismatch.
 *
 * What it does not do: talk to storage (that is `SecretStore`), or protect
 * against a compromised Worker, Cloudflare, or Q's model providers — "sealed
 * to Q" is the guarantee, not end-to-end (§6).
 *
 * `ANSWER_KEKS` shapes accepted (§7.2):
 *   - JSON: {"current":"k1","keys":{"k1":"<base64 32 bytes>", ...}}
 *   - a bare base64 string, read as {"current":"k1","keys":{"k1":<string>}}
 *     (the prod value as set 2026-09-07). The JSON shape is required from the
 *     first rotation onward, since a bare string can only hold one key.
 *
 * `kid` is namespaced: `local:<name>` = KEK from ANSWER_KEKS. `qkms:<id>` is
 * reserved for the Quilibrium KMS provider (C2, §7.11) and refused until then.
 * A bare `<name>` is read as `local:<name>` for envelopes written by v1.
 */

export const QENC_VERSION = 1 as const;
export const QENC_CONTENT_TYPE = 'application/vnd.qbase.qenc+json';

export interface Envelope {
  qenc: typeof QENC_VERSION;
  /** `local:k1` — which KEK wrapped the DEK. */
  kid: string;
  /** AAD: `<storage key or table:id>|<tier>|<owner fid>`. Stored for the rewrap tool; not secret. */
  ctx: string;
  /** The DEK wrapped under the KEK: 12-byte IV + 48-byte ciphertext (32 + 16 tag). */
  dek: { iv: string; ct: string };
  /** Body IV (12 bytes) and ciphertext + tag. */
  iv: string;
  ct: string;
}

export interface KeyRingInfo {
  current: string;
  kids: string[];
  shape: 'json' | 'bare';
}

export class SecretNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretNotReadyError';
  }
}

export class SecretContextMismatchError extends Error {
  constructor(expected: string, found: string) {
    super(`sealed object context mismatch: expected "${expected}", envelope says "${found}"`);
    this.name = 'SecretContextMismatchError';
  }
}

type KeyRing = {
  current: string;
  keys: Map<string, CryptoKey>;
  shape: 'json' | 'bare';
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

const LOCAL_PREFIX = 'local:';
const QKMS_PREFIX = 'qkms:';

/** Imported key rings, keyed by the raw secret so a changed secret is re-read. */
const rings = new Map<string, Promise<KeyRing>>();

const enc = new TextEncoder();

function b64encode(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function b64decode(text: string): Uint8Array {
  const bin = atob(text.trim());
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function importKek(name: string, b64: string): Promise<CryptoKey> {
  let raw: Uint8Array;
  try {
    raw = b64decode(b64);
  } catch {
    throw new SecretNotReadyError(`ANSWER_KEKS: key "${name}" is not valid base64`);
  }
  if (raw.byteLength !== 32) {
    throw new SecretNotReadyError(`ANSWER_KEKS: key "${name}" is ${raw.byteLength} bytes, want 32`);
  }
  return crypto.subtle.importKey('raw', toArrayBuffer(raw), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

function parseSecret(raw: string): { current: string; keys: Record<string, string>; shape: 'json' | 'bare' } {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new SecretNotReadyError('ANSWER_KEKS: JSON shape did not parse');
    }
    const obj = parsed as { current?: unknown; keys?: unknown };
    if (typeof obj.current !== 'string' || !obj.keys || typeof obj.keys !== 'object') {
      throw new SecretNotReadyError('ANSWER_KEKS: JSON must be {"current": "<kid>", "keys": {"<kid>": "<base64>"}}');
    }
    const keys = obj.keys as Record<string, unknown>;
    for (const [k, v] of Object.entries(keys)) {
      if (typeof v !== 'string') throw new SecretNotReadyError(`ANSWER_KEKS: key "${k}" is not a string`);
    }
    if (!(obj.current in keys)) {
      throw new SecretNotReadyError(`ANSWER_KEKS: current key "${obj.current}" is not in keys`);
    }
    return { current: obj.current, keys: keys as Record<string, string>, shape: 'json' };
  }
  return { current: 'k1', keys: { k1: trimmed }, shape: 'bare' };
}

async function loadRing(env: Env): Promise<KeyRing> {
  const raw = env?.ANSWER_KEKS;
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new SecretNotReadyError('ANSWER_KEKS is not set; Secret-tier writes are refused');
  }
  const cached = rings.get(raw);
  if (cached) return cached;
  const pending = (async (): Promise<KeyRing> => {
    const parsed = parseSecret(raw);
    const keys = new Map<string, CryptoKey>();
    for (const [name, b64] of Object.entries(parsed.keys)) {
      keys.set(name, await importKek(name, b64));
    }
    console.log(`[SecretBox] ANSWER_KEKS loaded: shape=${parsed.shape} keys=${[...keys.keys()].join(',')} current=${parsed.current}`);
    return { current: parsed.current, keys, shape: parsed.shape };
  })();
  rings.set(raw, pending);
  try {
    return await pending;
  } catch (e) {
    rings.delete(raw);
    throw e;
  }
}

function localName(kid: string): string {
  if (kid.startsWith(QKMS_PREFIX)) {
    throw new Error(`SecretBox: kid "${kid}" needs the QKMS provider, which is not available before C2`);
  }
  return kid.startsWith(LOCAL_PREFIX) ? kid.slice(LOCAL_PREFIX.length) : kid;
}

function kekFor(ring: KeyRing, kid: string): CryptoKey {
  const key = ring.keys.get(localName(kid));
  if (!key) throw new Error(`SecretBox: unknown kid "${kid}" (have ${[...ring.keys.keys()].map(k => LOCAL_PREFIX + k).join(', ')})`);
  return key;
}

async function aesGcmEncrypt(key: CryptoKey, aad: Uint8Array, plaintext: Uint8Array): Promise<{ iv: Uint8Array; ct: Uint8Array }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv), additionalData: toArrayBuffer(aad) },
    key,
    toArrayBuffer(plaintext),
  );
  return { iv, ct: new Uint8Array(ct) };
}

async function aesGcmDecrypt(key: CryptoKey, aad: Uint8Array, iv: Uint8Array, ct: Uint8Array): Promise<Uint8Array> {
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv), additionalData: toArrayBuffer(aad) },
    key,
    toArrayBuffer(ct),
  );
  return new Uint8Array(pt);
}

async function unwrapDek(ring: KeyRing, envelope: Envelope, usage: Array<'encrypt' | 'decrypt'>): Promise<{ raw: Uint8Array; key: CryptoKey }> {
  const kek = kekFor(ring, envelope.kid);
  const aad = enc.encode(envelope.ctx);
  const raw = await aesGcmDecrypt(kek, aad, b64decode(envelope.dek.iv), b64decode(envelope.dek.ct));
  const key = await crypto.subtle.importKey('raw', toArrayBuffer(raw), { name: 'AES-GCM' }, false, usage);
  return { raw, key };
}

/** True when `x` is a v1 envelope. Anything else is legacy plaintext (§7.7). */
export function isEnvelope(x: unknown): x is Envelope {
  if (!x || typeof x !== 'object') return false;
  const e = x as Partial<Envelope>;
  return e.qenc === QENC_VERSION
    && typeof e.kid === 'string'
    && typeof e.ctx === 'string'
    && typeof e.iv === 'string'
    && typeof e.ct === 'string'
    && !!e.dek && typeof e.dek.iv === 'string' && typeof e.dek.ct === 'string';
}

/** Seal bytes under a fresh DEK wrapped by the current KEK. */
export async function seal(env: Env, plaintext: Uint8Array, ctx: string): Promise<Envelope> {
  const ring = await loadRing(env);
  const kek = ring.keys.get(ring.current)!;
  const aad = enc.encode(ctx);
  const dekRaw = crypto.getRandomValues(new Uint8Array(32));
  const dek = await crypto.subtle.importKey('raw', toArrayBuffer(dekRaw), { name: 'AES-GCM' }, false, ['encrypt']);
  const body = await aesGcmEncrypt(dek, aad, plaintext);
  const wrapped = await aesGcmEncrypt(kek, aad, dekRaw);
  return {
    qenc: QENC_VERSION,
    kid: LOCAL_PREFIX + ring.current,
    ctx,
    dek: { iv: b64encode(wrapped.iv), ct: b64encode(wrapped.ct) },
    iv: b64encode(body.iv),
    ct: b64encode(body.ct),
  };
}

/** Open an envelope. `ctx` must equal what the writer sealed under, recomputed by the caller. */
export async function open(env: Env, envelope: Envelope, ctx: string): Promise<Uint8Array> {
  if (!isEnvelope(envelope)) throw new Error('SecretBox.open: not a qenc envelope');
  if (envelope.ctx !== ctx) throw new SecretContextMismatchError(ctx, envelope.ctx);
  const ring = await loadRing(env);
  const { key: dek } = await unwrapDek(ring, envelope, ['decrypt']);
  return aesGcmDecrypt(dek, enc.encode(ctx), b64decode(envelope.iv), b64decode(envelope.ct));
}

/** Re-wrap the DEK under the current KEK; the body is untouched (§7.8). Returns the same object when already current. */
export async function rewrap(env: Env, envelope: Envelope): Promise<Envelope> {
  if (!isEnvelope(envelope)) throw new Error('SecretBox.rewrap: not a qenc envelope');
  const ring = await loadRing(env);
  if (localName(envelope.kid) === ring.current) return envelope;
  const { raw } = await unwrapDek(ring, envelope, ['decrypt']);
  const wrapped = await aesGcmEncrypt(ring.keys.get(ring.current)!, enc.encode(envelope.ctx), raw);
  return {
    ...envelope,
    kid: LOCAL_PREFIX + ring.current,
    dek: { iv: b64encode(wrapped.iv), ct: b64encode(wrapped.ct) },
  };
}

/** Convenience: seal a UTF-8 string, returning the envelope as JSON text. */
export async function sealText(env: Env, text: string, ctx: string): Promise<string> {
  return JSON.stringify(await seal(env, enc.encode(text), ctx));
}

/** Convenience: open envelope JSON text back to a UTF-8 string. */
export async function openText(env: Env, envelopeJson: string, ctx: string): Promise<string> {
  const envelope = JSON.parse(envelopeJson) as unknown;
  if (!isEnvelope(envelope)) throw new Error('SecretBox.openText: not a qenc envelope');
  return new TextDecoder().decode(await open(env, envelope, ctx));
}

/** `local:<current>` — the kid new seals will carry. */
export async function currentKid(env: Env): Promise<string> {
  return LOCAL_PREFIX + (await loadRing(env)).current;
}

/** Throws `SecretNotReadyError` when the secret is missing or malformed; otherwise describes the ring (names only). */
export async function assertReady(env: Env): Promise<KeyRingInfo> {
  const ring = await loadRing(env);
  return { current: ring.current, kids: [...ring.keys.keys()].map(k => LOCAL_PREFIX + k), shape: ring.shape };
}

export async function isReady(env: Env): Promise<boolean> {
  try {
    await loadRing(env);
    return true;
  } catch {
    return false;
  }
}

/** The kid an envelope was written under, normalised to `local:<name>`. */
export function kidOf(envelope: Envelope): string {
  return LOCAL_PREFIX + localName(envelope.kid);
}

export const SecretBox = { seal, open, rewrap, sealText, openText, isEnvelope, currentKid, assertReady, isReady, kidOf };
