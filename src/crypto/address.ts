/**
 * Quilibrium-compatible address derivation
 * 
 * Address = base58btc(multihash(SHA-256(publicKey)))
 * Multihash prefix: 0x12 0x20 (SHA2-256, 32 bytes)
 * 
 * This produces addresses identical to the Quilibrium SDK.
 */

import { sha256 } from '@noble/hashes/sha256';
import { base58btc } from 'multiformats/bases/base58';

/** Derive a Quilibrium-compatible address from an Ed448 public key */
export function deriveAddress(publicKey: Uint8Array | number[]): string {
  const keyBytes = publicKey instanceof Uint8Array
    ? publicKey
    : new Uint8Array(publicKey);
  
  const hash = sha256(keyBytes);
  // Multihash: 0x12 = SHA2-256 function code, 0x20 = 32 bytes digest length
  const multihash = new Uint8Array([0x12, 0x20, ...hash]);
  return base58btc.encode(multihash);
}
