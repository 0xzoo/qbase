/**
 * SecretStore — the Secret-tier choke point (docs/specs/private-answer-encryption.md §7.4–§7.7).
 *
 * Against an in-memory object store: putJSON writes only envelopes, getJSON is
 * bound to tier + owner, plaintext in the store is refused (tolerance removed
 * after the 2026-09-07 migration), the D1 helpers round-trip, and rewrapText
 * follows a rotation.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import {
  putJSON, getJSON, peek, deleteObject, sealForD1, openFromD1, rewrapText, ctxFor, setObjectStoreForTests,
  type ObjectStore,
} from '../../../worker/services/secret/SecretStore';
import { isEnvelope, QENC_CONTENT_TYPE, SecretNotReadyError } from '../../../worker/services/secret/SecretBox';

function randomKeyB64(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
}
const K1 = randomKeyB64();
const K2 = randomKeyB64();
const env = { ANSWER_KEKS: K1 };
const rotated = { ANSWER_KEKS: JSON.stringify({ current: 'k2', keys: { k1: K1, k2: K2 } }) };

class MemStore implements ObjectStore {
  objects = new Map<string, { text: string; contentType?: string; meta?: Record<string, string> }>();
  puts = 0;
  async put(key: string, data: string, meta?: Record<string, string>, contentType?: string) {
    this.puts++;
    this.objects.set(key, { text: data, contentType, meta });
    return { success: true, key };
  }
  async get(key: string) {
    const o = this.objects.get(key);
    return o ? { data: new TextEncoder().encode(o.text).buffer as ArrayBuffer } : null;
  }
  async delete(key: string) {
    return this.objects.delete(key);
  }
}

let mem: MemStore;
beforeEach(() => {
  mem = new MemStore();
  setObjectStoreForTests(mem);
});
afterAll(() => setObjectStoreForTests(null));

const KEY = 'answers/private/a1';
const OBJ = { value: 'I skipped my sister\'s wedding', answer_data: { index: 3 }, reasoning: null };

describe('SecretStore', () => {
  it('putJSON stores an envelope with the qenc content type and no plaintext', async () => {
    await putJSON(env, KEY, OBJ, { tier: 'Private', owner: 42, meta: { 'q-id': 'q1' } });
    const stored = mem.objects.get(KEY)!;
    expect(stored.contentType).toBe(QENC_CONTENT_TYPE);
    expect(stored.meta).toEqual({ 'q-id': 'q1' });
    expect(stored.text).not.toContain('wedding');
    expect(stored.text).not.toContain('"index":3');
    const parsed = JSON.parse(stored.text);
    expect(isEnvelope(parsed)).toBe(true);
    expect(parsed.ctx).toBe(ctxFor(KEY, 'Private', 42));
  });

  it('getJSON opens for the right tier + owner and refuses another owner or tier', async () => {
    await putJSON(env, KEY, OBJ, { tier: 'Private', owner: 42 });
    expect(await getJSON(env, KEY, { tier: 'Private', owner: 42 })).toEqual(OBJ);
    await expect(getJSON(env, KEY, { tier: 'Private', owner: 43 })).rejects.toThrow(/context mismatch/);
    await expect(getJSON(env, KEY, { tier: 'Allowlist', owner: 42 })).rejects.toThrow(/context mismatch/);
    expect(await getJSON(env, 'answers/private/nope', { tier: 'Private', owner: 42 })).toBeNull();
  });

  it('writes nothing when no key is configured', async () => {
    await expect(putJSON({}, KEY, OBJ, { tier: 'Private', owner: 42 })).rejects.toBeInstanceOf(SecretNotReadyError);
    expect(mem.objects.size).toBe(0);
    expect(mem.puts).toBe(0);
  });

  it('refuses a plaintext object in the store (legacy tolerance removed) and leaves it untouched', async () => {
    mem.objects.set(KEY, { text: JSON.stringify(OBJ), contentType: 'application/json' });
    await expect(getJSON(env, KEY, { tier: 'Private', owner: 42 })).rejects.toThrow(/plaintext object .* legacy tolerance/);
    expect(mem.puts).toBe(0);
    expect(mem.objects.get(KEY)!.text).toBe(JSON.stringify(OBJ));
    await expect(getJSON(env, KEY, { tier: 'Private', owner: 42 })).rejects.toThrow();
    // Not JSON at all is refused with its own message.
    mem.objects.set(KEY, { text: 'garbage' });
    await expect(getJSON(env, KEY, { tier: 'Private', owner: 42 })).rejects.toThrow(/neither an envelope nor JSON/);
  });

  it('peek reports envelope vs legacy; deleteObject removes', async () => {
    mem.objects.set('legacy', { text: '["a","b"]' });
    await putJSON(env, 'sealed', ['a', 'b'], { tier: 'session', owner: 7 });
    expect((await peek(env, 'legacy'))!.envelope).toBeNull();
    expect((await peek(env, 'sealed'))!.envelope).not.toBeNull();
    expect(await peek(env, 'missing')).toBeNull();
    expect(await deleteObject(env, 'sealed')).toBe(true);
    expect(await peek(env, 'sealed')).toBeNull();
  });

  it('sealForD1 / openFromD1 round-trip JSON text and refuse plaintext', async () => {
    const answers = JSON.stringify([{ queryId: 'q1', optionIndex: 2 }, { queryId: 'q2', optionIndex: 0 }]);
    const ctx = 'quiz_completions:c1|private|42';
    const sealed = await sealForD1(env, answers, ctx);
    expect(sealed.startsWith('{"qenc":1')).toBe(true);
    expect(sealed).not.toContain('optionIndex');
    expect(await openFromD1(env, sealed, ctx)).toEqual(JSON.parse(answers));
    await expect(openFromD1(env, sealed, 'quiz_completions:c1|private|43')).rejects.toThrow(/context mismatch/);
    await expect(openFromD1(env, answers, ctx)).rejects.toThrow(/plaintext object .* legacy tolerance/);
  });

  it('rewrapText follows a rotation and is a no-op when current', async () => {
    const ctx = 'quiz_completions:c1|private|42';
    const sealed = await sealForD1(env, '[1,2,3]', ctx);
    expect(await rewrapText(env, '[1,2,3]')).toBeNull();
    const same = await rewrapText(env, sealed);
    expect(same).toEqual({ text: sealed, changed: false });
    const moved = await rewrapText(rotated, sealed);
    expect(moved!.changed).toBe(true);
    expect(JSON.parse(moved!.text).kid).toBe('local:k2');
    expect(await openFromD1(rotated, moved!.text, ctx)).toEqual([1, 2, 3]);
  });
});
