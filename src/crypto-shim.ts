// Browser shim for Node's 'crypto' module
// The Quil SDK uses:
//   - crypto.createHash('sha256') (multiformats, line 168)
//   - window.crypto.subtle / window.crypto.getRandomValues (passkey flows)

import { sha256 } from '@noble/hashes/sha256';

function createHash(algorithm: string) {
  if (algorithm !== 'sha256') {
    throw new Error(`crypto-shim: unsupported hash algorithm "${algorithm}"`);
  }
  let data: Uint8Array | null = null;
  return {
    update(input: Uint8Array | string) {
      if (typeof input === 'string') {
        data = new TextEncoder().encode(input);
      } else {
        data = input;
      }
      return this;
    },
    digest() {
      if (!data) throw new Error('crypto-shim: no data to hash');
      return sha256(data);
    },
  };
}

const cryptoShim = {
  ...globalThis.crypto,
  createHash,
  getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto),
  subtle: globalThis.crypto.subtle,
};

export default cryptoShim;
export { createHash };
export const webcrypto = globalThis.crypto;
