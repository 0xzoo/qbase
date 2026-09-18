/**
 * qbase crypto module
 * 
 * Replaces @quilibrium/quilibrium-js-sdk-channels (1.2MB WASM + JS)
 * with @noble/curves/ed448 (~15KB) + native WebCrypto.
 * 
 * Same addresses, same key format, same signatures — just smaller and faster.
 */

export { generateKeypair, getPublicKey, sign, verify } from './ed448';
export { deriveAddress } from './address';
export {
  register,
  authenticate,
  signWithPasskey,
  getPublicPasskeys,
  getCurrentPasskey,
  removePasskey,
  type StoredPasskey,
  type RegisterResult,
} from './passkey';
