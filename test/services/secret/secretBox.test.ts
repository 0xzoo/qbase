/**
 * SecretBox — envelope encryption primitive (docs/specs/private-answer-encryption.md §7.1–§7.3, §7.8).
 *
 * Pins: seal/open round-trip under both ANSWER_KEKS shapes, ciphertext holds no
 * plaintext, AAD binds the envelope to its context, unknown kid and missing /
 * malformed secret are refused, rewrap moves the DEK without touching the body.
 */

import { describe, it, expect } from 'vitest';
import {
  SecretBox, isEnvelope, kidOf, SecretNotReadyError, SecretContextMismatchError, QENC_VERSION,
} from '../../../worker/services/secret/SecretBox';

function randomKeyB64(): string {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...raw));
}

const K1 = randomKeyB64();
const K2 = randomKeyB64();
const bare = { ANSWER_KEKS: K1 };
const json = { ANSWER_KEKS: JSON.stringify({ current: 'k1', keys: { k1: K1 } }) };
const rotated = { ANSWER_KEKS: JSON.stringify({ current: 'k2', keys: { k1: K1, k2: K2 } }) };
const k2only = { ANSWER_KEKS: JSON.stringify({ current: 'k2', keys: { k2: K2 } }) };

const enc = new TextEncoder();
const dec = new TextDecoder();
const CTX = 'answers/private/abc|Private|42';
const PLAIN = 'the quick brown fox confesses: {"value":"yes","answer_data":{"index":2}}';

describe('SecretBox', () => {
  it('seals and opens under a bare-string secret, treated as k1', async () => {
    const env = await SecretBox.seal(bare, enc.encode(PLAIN), CTX);
    expect(isEnvelope(env)).toBe(true);
    expect(env.qenc).toBe(QENC_VERSION);
    expect(env.kid).toBe('local:k1');
    expect(env.ctx).toBe(CTX);
    expect(dec.decode(await SecretBox.open(bare, env, CTX))).toBe(PLAIN);
    const info = await SecretBox.assertReady(bare);
    expect(info).toEqual({ current: 'k1', kids: ['local:k1'], shape: 'bare' });
  });

  it('the JSON shape with the same key opens what the bare shape sealed, and vice versa', async () => {
    const a = await SecretBox.seal(bare, enc.encode(PLAIN), CTX);
    const b = await SecretBox.seal(json, enc.encode(PLAIN), CTX);
    expect(dec.decode(await SecretBox.open(json, a, CTX))).toBe(PLAIN);
    expect(dec.decode(await SecretBox.open(bare, b, CTX))).toBe(PLAIN);
    expect((await SecretBox.assertReady(json)).shape).toBe('json');
  });

  it('the envelope carries no plaintext and a fresh IV/DEK every time', async () => {
    const a = await SecretBox.seal(bare, enc.encode(PLAIN), CTX);
    const b = await SecretBox.seal(bare, enc.encode(PLAIN), CTX);
    const text = JSON.stringify(a);
    expect(text).not.toContain('quick brown fox');
    expect(text).not.toContain('"index":2');
    expect(a.ct).not.toBe(b.ct);
    expect(a.iv).not.toBe(b.iv);
    expect(a.dek.ct).not.toBe(b.dek.ct);
    // DEK wrap = 32-byte key + 16-byte tag
    expect(atob(a.dek.ct).length).toBe(48);
    expect(atob(a.iv).length).toBe(12);
  });

  it('refuses a context mismatch before touching the key, and a forged ctx fails the AAD check', async () => {
    const env = await SecretBox.seal(bare, enc.encode(PLAIN), CTX);
    await expect(SecretBox.open(bare, env, 'answers/private/abc|Private|43')).rejects.toBeInstanceOf(SecretContextMismatchError);
    // Same body, envelope ctx rewritten to the reader's expectation: the AAD no longer matches.
    const forged = { ...env, ctx: 'answers/private/abc|Private|43' };
    await expect(SecretBox.open(bare, forged, 'answers/private/abc|Private|43')).rejects.toThrow();
  });

  it('refuses an unknown kid and the qkms provider', async () => {
    const env = await SecretBox.seal(rotated, enc.encode(PLAIN), CTX); // kid local:k2
    await expect(SecretBox.open(json, env, CTX)).rejects.toThrow(/unknown kid "local:k2"/);
    await expect(SecretBox.open(json, { ...env, kid: 'qkms:abc' }, CTX)).rejects.toThrow(/QKMS/);
  });

  it('accepts a bare `<name>` kid as local (v1 envelopes)', async () => {
    const env = await SecretBox.seal(bare, enc.encode(PLAIN), CTX);
    expect(dec.decode(await SecretBox.open(bare, { ...env, kid: 'k1' }, CTX))).toBe(PLAIN);
    expect(kidOf({ ...env, kid: 'k1' })).toBe('local:k1');
  });

  it('is not ready without a usable secret, and seals nothing', async () => {
    await expect(SecretBox.seal({}, enc.encode(PLAIN), CTX)).rejects.toBeInstanceOf(SecretNotReadyError);
    await expect(SecretBox.seal({ ANSWER_KEKS: '' }, enc.encode(PLAIN), CTX)).rejects.toBeInstanceOf(SecretNotReadyError);
    await expect(SecretBox.assertReady({ ANSWER_KEKS: 'not base64 !!' })).rejects.toBeInstanceOf(SecretNotReadyError);
    await expect(SecretBox.assertReady({ ANSWER_KEKS: btoa('short') })).rejects.toThrow(/5 bytes, want 32/);
    await expect(SecretBox.assertReady({ ANSWER_KEKS: '{"current":"k9","keys":{"k1":"' + K1 + '"}}' })).rejects.toThrow(/not in keys/);
    await expect(SecretBox.assertReady({ ANSWER_KEKS: '{"nope":1}' })).rejects.toBeInstanceOf(SecretNotReadyError);
    expect(await SecretBox.isReady({})).toBe(false);
    expect(await SecretBox.isReady(bare)).toBe(true);
  });

  it('rewrap moves the DEK to the current key and leaves the body untouched', async () => {
    const v1 = await SecretBox.seal(bare, enc.encode(PLAIN), CTX);
    const v2 = await SecretBox.rewrap(rotated, v1);
    expect(v2.kid).toBe('local:k2');
    expect(v2.ct).toBe(v1.ct);
    expect(v2.iv).toBe(v1.iv);
    expect(v2.dek.ct).not.toBe(v1.dek.ct);
    expect(dec.decode(await SecretBox.open(rotated, v2, CTX))).toBe(PLAIN);
    // Once k1 is dropped from the ring the rewrapped envelope still opens; the old one does not.
    expect(dec.decode(await SecretBox.open(k2only, v2, CTX))).toBe(PLAIN);
    await expect(SecretBox.open(k2only, v1, CTX)).rejects.toThrow(/unknown kid/);
    // Already current → same object back.
    expect(await SecretBox.rewrap(rotated, v2)).toBe(v2);
    expect(await SecretBox.currentKid(rotated)).toBe('local:k2');
  });

  it('sealText / openText round-trip UTF-8', async () => {
    const text = '{"reflection":"naïve — 日本語 🙂"}';
    const sealed = await SecretBox.sealText(json, text, CTX);
    expect(sealed).not.toContain('naïve');
    expect(await SecretBox.openText(json, sealed, CTX)).toBe(text);
  });

  it('isEnvelope rejects plaintext JSON and partial shapes', () => {
    expect(isEnvelope({ value: 'x' })).toBe(false);
    expect(isEnvelope([1, 2])).toBe(false);
    expect(isEnvelope(null)).toBe(false);
    expect(isEnvelope({ qenc: 1, kid: 'local:k1' })).toBe(false);
  });
});
