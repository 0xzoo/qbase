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
import { getPrfEvalParams, wrapPrivateKey, unwrapPrivateKey } from './prfWrap';

// ── Types ──

export interface StoredPasskey {
  credentialId: string;   // base64url credential ID
  address: string;        // Quilibrium-format address
  publicKey: number[];    // Ed448 public key as number array
  displayName?: string;
  createdAt: string;
}

/**
 * Internal storage shape supports two states:
 *
 * - `prfWrapped: true`  → `_wrappedPrivateKey` + `_iv` set, `_privateKey`
 *   absent. Decryptable only inside a WebAuthn ceremony that yields a PRF
 *   output. XSS that reads localStorage cannot recover the Ed448 key.
 *
 * - `prfWrapped: false` → `_privateKey` is a base64 plaintext Ed448 key.
 *   Used for fresh registrations on browsers without PRF support, and as
 *   the initial state for any registration (lazy-upgraded on first
 *   authentication that yields a PRF output). XSS still recovers the key
 *   in this state — visible in console as a `[passkey]` warning.
 */
interface StoredPasskeyInternal extends StoredPasskey {
  prfWrapped: boolean;
  _privateKey?: string;          // legacy/transitional plaintext
  _wrappedPrivateKey?: string;   // AES-GCM ciphertext, base64
  _iv?: string;                  // AES-GCM IV, base64
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
      // Enable PRF for this credential so subsequent assertions can yield a
      // hardware-backed secret. We don't request `eval` here — Safari only
      // returns PRF output during `get`, not `create`. On first sign-in the
      // ceremony will derive the wrap key and re-encrypt the Ed448 private
      // key (lazy upgrade in signLoginChallenge).
      extensions: { prf: {} } as AuthenticationExtensionsClientInputs,
    },
  }) as PublicKeyCredential;

  if (!credential) {
    throw new Error('Passkey creation failed — no credential returned');
  }

  // Generate Ed448 identity keypair
  const keypair = generateKeypair();
  const address = deriveAddress(keypair.publicKey);
  const credentialId = bufferToBase64url(credential.rawId);

  // Build stored passkey. Initial state is plaintext; lazy-upgraded on the
  // next signing ceremony that successfully yields PRF output. The window
  // of plaintext exposure is registration → first sign-in (typically
  // immediate). PRF availability is reported by the caller's first
  // signLoginChallenge call.
  const stored: StoredPasskeyInternal = {
    credentialId,
    address,
    publicKey: publicKeyToArray(keypair.publicKey),
    displayName: userDisplayName,
    createdAt: new Date().toISOString(),
    prfWrapped: false,
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

// ── Signing (login challenge + QStorage ownership proofs) ──

/**
 * Run a WebAuthn `get` ceremony with PRF eval and return both the assertion
 * and the PRF output (when available). Caller is responsible for using the
 * PRF output to unwrap the Ed448 key.
 */
async function ceremonyWithPrf(
  credentialId: string,
): Promise<{ assertion: PublicKeyCredential; prfOutput: ArrayBuffer | null }> {
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const rpId = window.location.hostname;
  const prfEval = await getPrfEvalParams();

  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge,
      rpId,
      allowCredentials: [{
        id: base64urlToBuffer(credentialId),
        type: 'public-key',
        transports: ['internal'],
      }],
      userVerification: 'required',
      timeout: 60000,
      extensions: { prf: { eval: prfEval } } as AuthenticationExtensionsClientInputs,
    },
  }) as PublicKeyCredential;

  if (!assertion) {
    throw new Error('Passkey authentication failed — no assertion returned');
  }

  const ext = assertion.getClientExtensionResults?.() as
    | { prf?: { results?: { first?: ArrayBuffer } } }
    | undefined;
  const prfOutput = ext?.prf?.results?.first ?? null;
  return { assertion, prfOutput };
}

/**
 * Sign a payload with the Ed448 private key associated with a passkey
 * address. Used for QStorage ownership proofs.
 *
 * Plaintext-only path: doesn't trigger a WebAuthn ceremony, doesn't
 * unwrap PRF-protected keys. PRF-wrapped keys must use signLoginChallenge
 * (or grow this function to take an optional pre-fetched prfOutput). For
 * now this is fine — QStorage flows aren't gated on PRF unwrap.
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

  if (target.prfWrapped) {
    throw new Error(
      'signWithPasskey cannot unwrap a PRF-protected key directly — use the ' +
      'login ceremony to derive PRF output and pass it through.',
    );
  }

  if (!target._privateKey) {
    throw new Error('Stored passkey has no usable private key');
  }

  const { sign } = await import('./ed448');
  const privateKey = privateKeyFromBase64(target._privateKey);
  return sign(payload, privateKey);
}

/**
 * Sign a base64-encoded challenge with the Ed448 private key for the given
 * address. Triggers a WebAuthn ceremony with PRF eval; the resulting PRF
 * output unwraps the encrypted Ed448 private key. For legacy plaintext
 * keys, on browsers that yield PRF output, this also lazy-upgrades the
 * stored key to the wrapped shape.
 *
 * Used by /api/auth/passkey/login — the only entry point that has both a
 * server-issued challenge to sign and a fresh user gesture (biometric)
 * available for the WebAuthn ceremony.
 */
export async function signLoginChallenge(address: string, challengeB64: string): Promise<string> {
  const challenge = base64ToBytesPublic(challengeB64);
  const stored = getStoredPasskeys();
  const target = stored.find(p => p.address === address);
  if (!target) {
    throw new Error(`No passkey found for address: ${address}`);
  }

  // Single ceremony: biometric prompt + PRF eval (when supported).
  const { prfOutput } = await ceremonyWithPrf(target.credentialId);

  let privateKey: Uint8Array;
  if (target.prfWrapped) {
    if (!prfOutput) {
      throw new Error(
        'Passkey is PRF-wrapped but the browser did not yield a PRF result. ' +
        'Try a different browser or recreate the passkey.',
      );
    }
    if (!target._wrappedPrivateKey || !target._iv) {
      throw new Error('Stored passkey is marked PRF-wrapped but missing ciphertext');
    }
    privateKey = await unwrapPrivateKey(target._wrappedPrivateKey, target._iv, prfOutput);
  } else {
    if (!target._privateKey) {
      throw new Error('Stored passkey has no usable private key');
    }
    privateKey = privateKeyFromBase64(target._privateKey);

    // Lazy upgrade: if the browser supports PRF, re-encrypt and persist so
    // the plaintext copy can be discarded.
    if (prfOutput) {
      try {
        const { ciphertext, iv } = await wrapPrivateKey(privateKey, prfOutput);
        const upgraded: StoredPasskeyInternal = {
          ...target,
          prfWrapped: true,
          _wrappedPrivateKey: ciphertext,
          _iv: iv,
          _privateKey: undefined,
        };
        savePasskey(upgraded);
        console.log('[passkey] Upgraded plaintext Ed448 key to PRF-wrapped storage');
      } catch (err) {
        // Lazy upgrade is best-effort — never block the sign.
        console.warn('[passkey] PRF lazy upgrade failed:', err);
      }
    } else if (typeof window !== 'undefined' && !target._privateKey?.startsWith('__upgraded')) {
      console.warn(
        '[passkey] PRF not available — Ed448 private key remains plaintext in localStorage. ' +
        'XSS on this origin would compromise the key.',
      );
    }
  }

  const { sign } = await import('./ed448');
  const sig = sign(challenge, privateKey);
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
