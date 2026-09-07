/**
 * SecretStore — the one path through which Secret-tier content is written to
 * and read from storage. Spec: docs/specs/private-answer-encryption.md §7.4–§7.7.
 *
 * Every Private / Allowlist answer blob, every quiz session answer blob and
 * every sealed completion snapshot goes through here. `putJSON` seals with
 * `SecretBox` before it touches Q Storage; `getJSON` is the only decrypt path
 * and runs server-side after the caller's ACL check. Ciphertext never leaves
 * the Worker.
 *
 * Legacy tolerance (§7.7): while the in-place migration runs, a stored object
 * that is plain JSON rather than a `qenc` envelope is still returned, logged,
 * and re-sealed on read when a key is available. Flip
 * `LEGACY_PLAINTEXT_TOLERATED` to false once `POST /api/admin/secret-migrate
 * {phase:"status"}` reports zero legacy objects; from then on plaintext in the
 * store is an error, not data.
 *
 * The object store is `QStorageService` in the Worker; tests inject an
 * in-memory store with `setObjectStoreForTests`.
 */

import { QStorageService } from '../QStorageService';
import { SecretBox, isEnvelope, QENC_CONTENT_TYPE, type Envelope } from './SecretBox';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

export interface ObjectStore {
  put(key: string, data: string, metadata?: Record<string, string>, contentType?: string): Promise<unknown>;
  get(key: string): Promise<{ data: ArrayBuffer } | null>;
  delete(key: string): Promise<boolean>;
}

export interface SealOpts {
  /** Audience or tier word that goes into the AAD: 'Private' | 'Allowlist' | 'session' | 'private' | ... */
  tier: string;
  /** Owner FID; part of the AAD so a blob cannot be re-pointed at another user. */
  owner: number | string;
  /** x-amz-meta-* headers for the object; never content. */
  meta?: Record<string, string>;
}

/** See the header. */
export const LEGACY_PLAINTEXT_TOLERATED = true;

let storeOverride: ObjectStore | null = null;

/** Tests only: route reads and writes to an in-memory store. Pass null to restore Q Storage. */
export function setObjectStoreForTests(store: ObjectStore | null): void {
  storeOverride = store;
}

export function objectStore(env: Env): ObjectStore {
  return storeOverride ?? QStorageService.fromEnv(env);
}

/** AAD for a stored object: location, tier, owner. */
export function ctxFor(key: string, tier: string, owner: number | string): string {
  return `${key}|${tier}|${owner}`;
}

const decoder = new TextDecoder();

/**
 * Open stored text: a `qenc` envelope is decrypted under `ctx`; legacy plaintext
 * JSON is tolerated per the header. Returns the plaintext JSON text.
 */
async function openStoredText(
  env: Env,
  text: string,
  ctx: string,
  onLegacy?: (plaintext: string) => Promise<void>,
): Promise<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`SecretStore: stored object at ${ctx} is neither an envelope nor JSON`);
  }
  if (isEnvelope(parsed)) {
    return decoder.decode(await SecretBox.open(env, parsed, ctx));
  }
  if (!LEGACY_PLAINTEXT_TOLERATED) {
    throw new Error(`SecretStore: plaintext object at ${ctx} after legacy tolerance was removed`);
  }
  console.warn(`[SecretStore] legacy plaintext read at ${ctx}`);
  if (onLegacy) {
    try {
      await onLegacy(text);
    } catch (e) {
      console.warn(`[SecretStore] re-seal on read failed at ${ctx}:`, e);
    }
  }
  return text;
}

/** Seal `obj` and write it. Throws `SecretNotReadyError` (nothing is written) when no key is configured. */
export async function putJSON(env: Env, key: string, obj: unknown, opts: SealOpts): Promise<void> {
  const ctx = ctxFor(key, opts.tier, opts.owner);
  const envelopeJson = await SecretBox.sealText(env, JSON.stringify(obj), ctx);
  await objectStore(env).put(key, envelopeJson, opts.meta, QENC_CONTENT_TYPE);
}

/** Read and open an object; null when it does not exist. Legacy plaintext is re-sealed in place when a key exists. */
export async function getJSON<T = unknown>(env: Env, key: string, opts: Omit<SealOpts, 'meta'>): Promise<T | null> {
  const store = objectStore(env);
  const stored = await store.get(key);
  if (!stored) return null;
  const ctx = ctxFor(key, opts.tier, opts.owner);
  const text = decoder.decode(stored.data);
  const plaintext = await openStoredText(env, text, ctx, async (legacy) => {
    if (!(await SecretBox.isReady(env))) return;
    const sealed = await SecretBox.sealText(env, legacy, ctx);
    await store.put(key, sealed, undefined, QENC_CONTENT_TYPE);
    console.log(`[SecretStore] re-sealed legacy object at ${ctx}`);
  });
  return JSON.parse(plaintext) as T;
}

/** Raw read for the migration tool: the stored text and whether it is already an envelope. */
export async function peek(env: Env, key: string): Promise<{ text: string; envelope: Envelope | null } | null> {
  const stored = await objectStore(env).get(key);
  if (!stored) return null;
  const text = decoder.decode(stored.data);
  try {
    const parsed = JSON.parse(text) as unknown;
    return { text, envelope: isEnvelope(parsed) ? parsed : null };
  } catch {
    return { text, envelope: null };
  }
}

/** Write an already-built envelope (migration + rewrap). */
export async function putEnvelope(env: Env, key: string, envelope: Envelope, meta?: Record<string, string>): Promise<void> {
  await objectStore(env).put(key, JSON.stringify(envelope), meta, QENC_CONTENT_TYPE);
}

export async function deleteObject(env: Env, key: string): Promise<boolean> {
  return objectStore(env).delete(key);
}

/** Seal JSON text for a D1 column (`quiz_completions.answers_encrypted`). */
export async function sealForD1(env: Env, jsonText: string, ctx: string): Promise<string> {
  return SecretBox.sealText(env, jsonText, ctx);
}

/** Open a D1 column written by `sealForD1`; legacy plaintext JSON is tolerated per the header. */
export async function openFromD1<T = unknown>(env: Env, text: string, ctx: string): Promise<T> {
  return JSON.parse(await openStoredText(env, text, ctx)) as T;
}

/** Rewrap envelope JSON text under the current KEK; null when the text is not an envelope. */
export async function rewrapText(env: Env, text: string): Promise<{ text: string; changed: boolean } | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isEnvelope(parsed)) return null;
  const next = await SecretBox.rewrap(env, parsed);
  return next === parsed ? { text, changed: false } : { text: JSON.stringify(next), changed: true };
}

export const SecretStore = { putJSON, getJSON, peek, putEnvelope, deleteObject, sealForD1, openFromD1, rewrapText, ctxFor, objectStore };
