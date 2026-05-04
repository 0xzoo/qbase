/**
 * Native WebAuthn passkey management
 * Replaces the Quilibrium SDK's PasskeysProvider + WASM
 * 
 * Handles:
 * - WebAuthn credential creation (register)
 * - WebAuthn credential assertion (authenticate)
 * - Ed448 keypair generation + storage
 * - Passkey info persistence in localStorage
 */

import { generateKeypair, publicKeyToArray, privateKeyToBase64, privateKeyFromBase64 } from './ed448';
import { deriveAddress } from './address';

// ── Types ──

export interface StoredPasskey {
  credentialId: string;   // base64url credential ID
  address: string;        // Quilibrium-format address
  publicKey: number[];    // Ed448 public key as number array
  displayName?: string;
  createdAt: string;
}

interface StoredPasskeyInternal extends StoredPasskey {
  /** Ed448 private key, base64-encoded. Stored locally, never sent to server. */
  _privateKey: string;
}

// ── Constants ──

const STORAGE_KEY = 'qbase-passkeys';
const RP_NAME = 'qbase';

// ── Registration ──

export interface RegisterResult {
  passkey: StoredPasskey;
  rawCredentialId: string;
}

/**
 * Register a new passkey using native WebAuthn + Ed448 keypair.
 * 
 * 1. Creates a WebAuthn credential (biometric/PIN)
 * 2. Generates an Ed448 keypair
 * 3. Derives a Quilibrium-compatible address
 * 4. Stores everything locally
 */
export async function register(displayName?: string): Promise<RegisterResult> {
  // Generate challenge
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  
  // User ID (random, not PII)
  const userId = crypto.getRandomValues(new Uint8Array(16));
  const userDisplayName = displayName || `qbase-${Date.now()}`;
  
  // Get the RP ID from current hostname
  const rpId = window.location.hostname;
  
  const credential = await navigator.credentials.create({
    publicKey: {
      challenge,
      rp: {
        name: RP_NAME,
        id: rpId,
      },
      user: {
        id: userId,
        name: userDisplayName,
        displayName: userDisplayName,
      },
      pubKeyCredParams: [
        { alg: -7, type: 'public-key' },   // ES256 (P-256)
        { alg: -257, type: 'public-key' },  // RS256
      ],
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        residentKey: 'preferred',
        userVerification: 'required',
      },
      timeout: 60000,
    },
  }) as PublicKeyCredential;

  if (!credential) {
    throw new Error('Passkey creation failed — no credential returned');
  }

  // Generate Ed448 identity keypair
  const keypair = generateKeypair();
  const address = deriveAddress(keypair.publicKey);
  const credentialId = bufferToBase64url(credential.rawId);

  // Build stored passkey
  const stored: StoredPasskeyInternal = {
    credentialId,
    address,
    publicKey: publicKeyToArray(keypair.publicKey),
    displayName: userDisplayName,
    createdAt: new Date().toISOString(),
    _privateKey: privateKeyToBase64(keypair.privateKey),
  };

  // Persist to localStorage
  savePasskey(stored);

  return {
    passkey: toPublicPasskey(stored),
    rawCredentialId: credentialId,
  };
}

// ── Authentication ──

/**
 * Authenticate with an existing passkey via WebAuthn assertion.
 * 
 * 1. Finds stored passkey by credential ID or address
 * 2. Triggers WebAuthn authentication (biometric/PIN)
 * 3. Returns passkey info on success
 */
export async function authenticate(credentialIdOrAddress?: string): Promise<StoredPasskey> {
  const stored = getStoredPasskeys();
  
  if (stored.length === 0) {
    throw new Error('No stored passkeys found');
  }

  // Find the target passkey
  let target: StoredPasskeyInternal | undefined;
  if (credentialIdOrAddress) {
    target = stored.find(
      p => p.credentialId === credentialIdOrAddress || p.address === credentialIdOrAddress
    );
  }
  target = target || stored[0];

  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const rpId = window.location.hostname;

  // Build allowCredentials list
  const allowCredentials: PublicKeyCredentialDescriptor[] = [{
    id: base64urlToBuffer(target.credentialId),
    type: 'public-key',
    transports: ['internal'],
  }];

  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge,
      rpId,
      allowCredentials,
      userVerification: 'required',
      timeout: 60000,
    },
  }) as PublicKeyCredential;

  if (!assertion) {
    throw new Error('Passkey authentication failed — no assertion returned');
  }

  return toPublicPasskey(target);
}

// ── Signing (for QStorage ownership proofs) ──

/**
 * Sign a payload with the Ed448 private key associated with a passkey address.
 * Used for QStorage data ownership proofs and for login challenge/response.
 */
export async function signWithPasskey(
  address: string,
  payload: Uint8Array
): Promise<Uint8Array> {
  const stored = getStoredPasskeys();
  const target = stored.find(p => p.address === address);

  if (!target) {
    throw new Error(`No passkey found for address: ${address}`);
  }

  const { sign } = await import('./ed448');
  const privateKey = privateKeyFromBase64(target._privateKey);
  return sign(payload, privateKey);
}

/**
 * Sign a base64-encoded challenge with the local Ed448 private key for the
 * given address. Returns base64 signature suitable for sending to
 * `POST /api/auth/passkey/login`. Throws if no local key exists for the
 * address (e.g. fresh device with discoverable credential — caller should
 * recover by registering a new passkey on this device).
 */
export async function signLoginChallenge(address: string, challengeB64: string): Promise<string> {
  const challenge = base64ToBytesPublic(challengeB64);
  const sig = await signWithPasskey(address, challenge);
  return bytesToBase64Public(sig);
}

function base64ToBytesPublic(b64: string): Uint8Array {
  const bin = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToBase64Public(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

// ── Discoverable authentication ──

/**
 * Authenticate with any discoverable (resident) passkey registered for this origin.
 * Unlike authenticate(credentialId), this does NOT require anything in localStorage.
 * The browser/OS will prompt the user to pick from their stored credentials.
 *
 * 1. Triggers WebAuthn authentication with empty allowCredentials (discoverable mode)
 * 2. Returns the credentialId from the raw assertion
 */
export async function discover(): Promise<{ credentialId: string }> {
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const rpId = window.location.hostname;

  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge,
      rpId,
      userVerification: 'required',
      timeout: 60000,
      // allowCredentials omitted → discoverable / resident credential mode
      // (empty array [] causes Safari to skip prompting entirely)
    },
  }) as PublicKeyCredential;

  if (!assertion) {
    throw new Error('No discoverable passkey found');
  }

  const credentialId = bufferToBase64url(assertion.rawId);
  return { credentialId };
}

// ── Storage helpers ──

/** Get all stored passkeys (public info only) */
export function getPublicPasskeys(): StoredPasskey[] {
  return getStoredPasskeys().map(toPublicPasskey);
}

/** Get the current (most recent) passkey, or null */
export function getCurrentPasskey(): StoredPasskey | null {
  const stored = getStoredPasskeys();
  return stored.length > 0 ? toPublicPasskey(stored[stored.length - 1]) : null;
}

/** Remove a stored passkey by credential ID */
export function removePasskey(credentialId: string): void {
  const stored = getStoredPasskeys();
  const filtered = stored.filter(p => p.credentialId !== credentialId);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered));
}

// ── Internal helpers ──

function getStoredPasskeys(): StoredPasskeyInternal[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function savePasskey(passkey: StoredPasskeyInternal): void {
  const stored = getStoredPasskeys();
  // Replace if same credential ID exists, otherwise append
  const idx = stored.findIndex(p => p.credentialId === passkey.credentialId);
  if (idx >= 0) {
    stored[idx] = passkey;
  } else {
    stored.push(passkey);
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
}

function toPublicPasskey(internal: StoredPasskeyInternal): StoredPasskey {
  const { _privateKey: _, ...pub } = internal;
  return pub;
}

// ── Base64url encoding (WebAuthn uses ArrayBuffer) ──

function bufferToBase64url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlToBuffer(b64url: string): ArrayBuffer {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - b64.length % 4) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}
