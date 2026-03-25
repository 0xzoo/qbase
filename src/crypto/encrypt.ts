/**
 * E2EE encryption using WebCrypto (AES-256-GCM)
 * 
 * For Phase 3 private answers. Not wired up yet — built for future use.
 * 
 * Pattern:
 * 1. Derive symmetric key from Ed448 keypair via x448 + HKDF
 * 2. Encrypt with AES-256-GCM
 * 3. Store encrypted blob in QStorage
 */

const AES_KEY_BITS = 256;
const IV_BYTES = 12; // 96-bit IV for GCM

export interface EncryptedPayload {
  iv: Uint8Array;       // 12 bytes
  ciphertext: Uint8Array;
}

/** Encrypt plaintext with a raw 32-byte key */
export async function encrypt(
  plaintext: Uint8Array,
  rawKey: Uint8Array
): Promise<EncryptedPayload> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  
  const key = await crypto.subtle.importKey(
    'raw',
    rawKey,
    { name: 'AES-GCM', length: AES_KEY_BITS },
    false,
    ['encrypt']
  );
  
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext)
  );
  
  return { iv, ciphertext };
}

/** Decrypt ciphertext with a raw 32-byte key */
export async function decrypt(
  payload: EncryptedPayload,
  rawKey: Uint8Array
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    rawKey,
    { name: 'AES-GCM', length: AES_KEY_BITS },
    false,
    ['decrypt']
  );
  
  return new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: payload.iv },
      key,
      payload.ciphertext
    )
  );
}

/** Serialize encrypted payload to a single buffer: [iv (12) | ciphertext] */
export function serializePayload(payload: EncryptedPayload): Uint8Array {
  const buf = new Uint8Array(IV_BYTES + payload.ciphertext.length);
  buf.set(payload.iv, 0);
  buf.set(payload.ciphertext, IV_BYTES);
  return buf;
}

/** Deserialize a buffer back to iv + ciphertext */
export function deserializePayload(buf: Uint8Array): EncryptedPayload {
  return {
    iv: buf.slice(0, IV_BYTES),
    ciphertext: buf.slice(IV_BYTES),
  };
}
