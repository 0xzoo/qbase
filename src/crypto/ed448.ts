/**
 * Ed448 cryptographic operations using @noble/curves
 * Replaces the Quilibrium SDK's WASM-based Ed448 implementation
 * 
 * Used for:
 * - Keypair generation (identity keys)
 * - Signing (QStorage ownership proofs)
 * - Verification
 * - x448 key agreement (future E2EE)
 */

import { ed448 } from '@noble/curves/ed448';
import { randomBytes } from '@noble/hashes/utils';

export interface Ed448Keypair {
  privateKey: Uint8Array; // 57 bytes
  publicKey: Uint8Array;  // 57 bytes
}

/** Generate a new Ed448 keypair */
export function generateKeypair(): Ed448Keypair {
  const privateKey = randomBytes(57);
  const publicKey = ed448.getPublicKey(privateKey);
  return { privateKey, publicKey };
}

/** Get public key from private key */
export function getPublicKey(privateKey: Uint8Array): Uint8Array {
  return ed448.getPublicKey(privateKey);
}

/** Sign a message with Ed448 private key */
export function sign(message: Uint8Array, privateKey: Uint8Array): Uint8Array {
  return ed448.sign(message, privateKey);
}

/** Verify an Ed448 signature */
export function verify(
  signature: Uint8Array,
  message: Uint8Array,
  publicKey: Uint8Array
): boolean {
  return ed448.verify(signature, message, publicKey);
}

// ── Serialization helpers ──

export function privateKeyToBase64(key: Uint8Array): string {
  return btoa(String.fromCharCode(...key));
}

export function privateKeyFromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function publicKeyToArray(key: Uint8Array): number[] {
  return Array.from(key);
}

export function publicKeyFromArray(arr: number[]): Uint8Array {
  return new Uint8Array(arr);
}
