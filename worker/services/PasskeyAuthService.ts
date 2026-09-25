/**
 * Passkey Authentication Service
 *
 * Handles passkey user creation, registration storage, and session management.
 * Passkey users are identified by their Quilibrium address (Qm...).
 * Sessions use the same KV mechanism as Farcaster sessions.
 *
 * Login uses an Ed448 challenge/response: the server issues a one-time random
 * challenge bound to the address (stored in KV), and the client must return a
 * signature over that challenge made with the Ed448 private key derived during
 * registration. The server verifies against the stored public_key.
 */

import { ed448 } from '@noble/curves/ed448';
import {
  AccountError, createAccount, isRewritten, lookupUserKeyForFid, userKeyForFid,
} from './accounts/AccountService';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

const CHALLENGE_TTL_SECONDS = 300; // 5 minutes
const CHALLENGE_BYTE_LENGTH = 32;

function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Decode a stored Ed448 public key. The column has accumulated multiple
 * runtime shapes over time:
 *
 *  - Strings: hex, JSON-array text (`"[125,85,...]"`), comma-separated bytes.
 *  - BLOB: when the route handler binds a number[] from the client without
 *    stringifying first, D1 stores it as a BLOB and returns it as a
 *    `Uint8Array` / `ArrayBuffer` on read.
 *  - Plain `number[]`: defensive, in case D1's JS binding path ever gives
 *    that back directly.
 *
 * The write path (PasskeyAuthService.register) now normalizes incoming
 * publicKey to a JSON-array string, so new rows are uniform — but old
 * rows in all four shapes still need to verify, so accept them all here.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseStoredPublicKey(stored: any): Uint8Array | null {
  if (stored == null) return null;

  // Already a typed array / buffer (D1 BLOB read path).
  if (stored instanceof Uint8Array) return stored;
  if (stored instanceof ArrayBuffer) return new Uint8Array(stored);

  // Plain number[].
  if (Array.isArray(stored)) {
    return stored.every((n: unknown) => typeof n === 'number')
      ? new Uint8Array(stored)
      : null;
  }

  if (typeof stored !== 'string') return null;

  const s = stored.trim();
  if (!s) return null;
  if (/^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0) {
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
    return out;
  }
  if (s.startsWith('[')) {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr) && arr.every(n => typeof n === 'number')) {
        return new Uint8Array(arr);
      }
    } catch { /* fall through */ }
  }
  if (s.includes(',')) {
    const parts = s.split(',').map(p => p.trim());
    if (parts.every(p => /^\d+$/.test(p))) {
      return new Uint8Array(parts.map(p => parseInt(p, 10)));
    }
  }
  return null;
}

/**
 * Normalize the publicKey we're about to bind into D1. Clients have at
 * various points sent `number[]`, hex strings, and JSON-array strings.
 * Coerce all into a stable JSON-array string so column reads come back
 * as a string that parseStoredPublicKey hits via its `'['`-prefix branch.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizePublicKeyForStorage(publicKey: any): string {
  if (typeof publicKey === 'string') return publicKey;
  if (publicKey instanceof Uint8Array) return JSON.stringify(Array.from(publicKey));
  if (publicKey instanceof ArrayBuffer) return JSON.stringify(Array.from(new Uint8Array(publicKey)));
  if (Array.isArray(publicKey)) return JSON.stringify(publicKey);
  // Last-resort: stringify whatever it is so the bind doesn't throw.
  return String(publicKey);
}

export interface PasskeyUser {
  address: string;
  public_key: string;
  display_name: string | null;
  created_at: number;
  last_login_at: number | null;
  fid: number | null;
}

export interface PasskeyRegistration {
  id: number;
  address: string;
  credential_id: string;
  registration_data: string; // JSON string
  device_name: string | null;
  created_at: number;
  last_used_at: number | null;
}

export interface RegisterPasskeyParams {
  address: string;
  // Clients have shipped multiple shapes here (number[], hex string, JSON
  // text). normalizePublicKeyForStorage coerces all of them to a stable
  // JSON-array string before binding.
  publicKey: string | number[] | Uint8Array | ArrayBuffer;
  displayName?: string;
  credentialId: string;
  registrationData: unknown; // Will be JSON.stringified
  deviceName?: string;
  fid?: number;
}

export class PasskeyAuthService {
  /**
   * Register a new passkey user + credential.
   * If the user already exists, just adds/updates the registration.
   * Returns a session token.
   */
  static async register(
    env: Env,
    params: RegisterPasskeyParams
  ): Promise<{ sessionToken: string; address: string; isNewUser: boolean }> {
    const now = Date.now();
    let isNewUser = false;

    // Check if user exists
    const existing = await env.DB.prepare(
      'SELECT address FROM passkey_users WHERE address = ?'
    ).bind(params.address).first();

    // A passkey-only signup needs an account to own its profile row. Before the
    // account cutover person keys are fids, and a Users row with an automatic
    // rowid would collide with the fid space — refuse before writing anything
    // (docs/specs/account-root.md §6.1).
    const rewritten = await isRewritten(env);
    if (!existing && !params.fid && !rewritten) {
      throw new AccountError('passkey_only_signup_unavailable', 503);
    }

    if (!existing) {
      // Create new passkey user
      await env.DB.prepare(`
        INSERT INTO passkey_users (address, public_key, display_name, fid, created_at, last_login_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(
        params.address,
        normalizePublicKeyForStorage(params.publicKey),
        params.displayName || null,
        params.fid || null,
        now,
        now
      ).run();

      isNewUser = true;
      console.log(`[PASSKEY] ✅ Created new user: ${params.address}`);

      // Link to Users table with quil_address. Users.fid holds the person key.
      if (params.fid) {
        const key = await userKeyForFid(env, params.fid);
        await env.DB.prepare(
          'UPDATE users SET quil_address = ? WHERE fid = ?'
        ).bind(params.address, key).run();
      } else {
        // After the cutover only (checked above): mint a passkey-born account;
        // createAccount inserts its Users row (profile_source 'passkey').
        await createAccount(env, {
          kind: 'passkey',
          value: params.address,
          label: params.displayName || null,
          quilAddress: params.address,
        });
      }
    } else {
      // Update last login
      await env.DB.prepare(
        'UPDATE passkey_users SET last_login_at = ?, display_name = COALESCE(?, display_name) WHERE address = ?'
      ).bind(now, params.displayName || null, params.address).run();
    }

    // Upsert registration (replace if same credential_id exists)
    const registrationJson = typeof params.registrationData === 'string'
      ? params.registrationData
      : JSON.stringify(params.registrationData);

    await env.DB.prepare(`
      INSERT INTO passkey_registrations (address, credential_id, registration_data, device_name, created_at, last_used_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(credential_id) DO UPDATE SET
        registration_data = excluded.registration_data,
        last_used_at = excluded.last_used_at
    `).bind(
      params.address,
      params.credentialId,
      registrationJson,
      params.deviceName || null,
      now,
      now
    ).run();

    console.log(`[PASSKEY] ✅ Saved registration for credential: ${params.credentialId.substring(0, 20)}...`);

    // Look up linked FID for session
    const linkedUser = await env.DB.prepare(
      'SELECT fid FROM passkey_users WHERE address = ?'
    ).bind(params.address).first() as { fid: number | null } | null;

    // Create session
    const sessionToken = crypto.randomUUID();
    const expiresAt = now + (30 * 24 * 60 * 60 * 1000); // 30 days (longer than Farcaster's 7)

    await env.KV_USER_PROFILES.put(
      `session:${sessionToken}`,
      JSON.stringify({ passkeyAddress: params.address, quilAddress: params.address, fid: (linkedUser as any)?.fid || null, expiresAt }),
      { expirationTtl: 30 * 24 * 60 * 60 } // 30 days
    );

    console.log(`[PASSKEY] ✅ Created session for ${params.address}`);

    return { sessionToken, address: params.address, isNewUser };
  }

  /**
   * Issue a one-time Ed448 challenge for the given address. Stored in KV under
   * `passkey_challenge:{address}` with a short TTL. Returns the challenge as
   * base64. Returns null if the address is not registered.
   */
  static async issueChallenge(env: Env, address: string): Promise<string | null> {
    const user = await env.DB.prepare(
      'SELECT address FROM passkey_users WHERE address = ?'
    ).bind(address).first() as { address: string } | null;
    if (!user) return null;

    const challenge = crypto.getRandomValues(new Uint8Array(CHALLENGE_BYTE_LENGTH));
    await env.KV_USER_PROFILES.put(
      `passkey_challenge:${address}`,
      bytesToBase64(challenge),
      { expirationTtl: CHALLENGE_TTL_SECONDS }
    );
    return bytesToBase64(challenge);
  }

  /**
   * Login: verify an Ed448 signature over the server-issued challenge bound to
   * the address. The challenge is single-use — deleted from KV on success or
   * on signature-mismatch — to prevent replay.
   *
   * Returns null on any auth failure (unknown address, missing/expired
   * challenge, signature mismatch). The caller should respond with 401 in all
   * those cases — do not leak which path failed.
   */
  static async login(
    env: Env,
    address: string,
    signatureB64: string
  ): Promise<{ sessionToken: string; address: string; fid: number | null; displayName: string | null; fname: string | null } | null> {
    const now = Date.now();

    const user = await env.DB.prepare(
      'SELECT address, public_key, fid, display_name FROM passkey_users WHERE address = ?'
    ).bind(address).first() as { address: string; public_key: string; fid: number | null; display_name: string | null } | null;

    if (!user) {
      console.warn(`[PASSKEY] Login attempt for unknown address: ${address}`);
      return null;
    }

    const challengeKey = `passkey_challenge:${address}`;
    const storedChallengeB64 = await env.KV_USER_PROFILES.get(challengeKey);
    if (!storedChallengeB64) {
      console.warn(`[PASSKEY] Login attempt with no/expired challenge: ${address}`);
      return null;
    }

    // Best-effort consume the challenge before verification so a failed attempt
    // can't be retried with the same challenge.
    await env.KV_USER_PROFILES.delete(challengeKey);

    const publicKey = parseStoredPublicKey(user.public_key);
    if (!publicKey) {
      console.error(`[PASSKEY] Stored public_key for ${address} is malformed; cannot verify`);
      return null;
    }

    let challenge: Uint8Array;
    let signature: Uint8Array;
    try {
      challenge = base64ToBytes(storedChallengeB64);
      signature = base64ToBytes(signatureB64);
    } catch {
      console.warn(`[PASSKEY] Login signature/challenge not valid base64 for ${address}`);
      return null;
    }

    let valid = false;
    try {
      valid = ed448.verify(signature, challenge, publicKey);
    } catch (err) {
      console.warn(`[PASSKEY] ed448.verify threw for ${address}:`, err);
      return null;
    }

    if (!valid) {
      console.warn(`[PASSKEY] Signature verification failed for ${address}`);
      return null;
    }

    await env.DB.prepare(
      'UPDATE passkey_users SET last_login_at = ? WHERE address = ?'
    ).bind(now, address).run();

    let fname: string | null = null;
    if (user.fid) {
      // passkey_users.fid is the linked Farcaster fid; the Users row is keyed by the person key.
      const key = await lookupUserKeyForFid(env, Number(user.fid));
      const usersRow = key === undefined ? null : await env.DB.prepare(
        'SELECT fname FROM users WHERE fid = ?'
      ).bind(key).first() as { fname: string } | null;
      fname = usersRow?.fname || null;
    }

    const sessionToken = crypto.randomUUID();
    const expiresAt = now + (30 * 24 * 60 * 60 * 1000);
    await env.KV_USER_PROFILES.put(
      `session:${sessionToken}`,
      JSON.stringify({ passkeyAddress: address, quilAddress: address, fid: user.fid || null, expiresAt }),
      { expirationTtl: 30 * 24 * 60 * 60 }
    );

    console.log(`[PASSKEY] ✅ Verified login for ${address} (fid: ${user.fid || 'none'})`);
    return { sessionToken, address, fid: user.fid, displayName: user.display_name, fname };
  }

  /**
   * Resolve a WebAuthn credential id to its registered Quilibrium address.
   * Used by the discoverable-credential login flow.
   */
  static async resolveAddressByCredentialId(env: Env, credentialId: string): Promise<string | null> {
    const reg = await env.DB.prepare(
      'SELECT address FROM passkey_registrations WHERE credential_id = ? ORDER BY last_used_at DESC LIMIT 1'
    ).bind(credentialId).first() as { address: string } | null;
    return reg?.address || null;
  }

  /**
   * Get registration data for an address.
   * Used by the SDK's getUserRegistration callback.
   */
  static async getRegistration(
    env: Env,
    address: string
  ): Promise<unknown | null> {
    const row = await env.DB.prepare(`
      SELECT registration_data FROM passkey_registrations 
      WHERE address = ? 
      ORDER BY last_used_at DESC, created_at DESC 
      LIMIT 1
    `).bind(address).first() as { registration_data: string } | null;

    if (!row) return null;

    try {
      return JSON.parse(row.registration_data);
    } catch {
      return row.registration_data;
    }
  }

  /**
   * Get passkey user by address
   */
  static async getUser(env: Env, address: string): Promise<PasskeyUser | null> {
    const row = await env.DB.prepare(
      'SELECT * FROM passkey_users WHERE address = ?'
    ).bind(address).first();

    return row ? (row as PasskeyUser) : null;
  }

  /**
   * Link a Farcaster FID to a passkey user (for future use)
   */
  static async linkFarcaster(
    env: Env,
    address: string,
    fid: number
  ): Promise<boolean> {
    try {
      await env.DB.prepare(
        'UPDATE passkey_users SET fid = ? WHERE address = ?'
      ).bind(fid, address).run();
      console.log(`[PASSKEY] ✅ Linked FID ${fid} to ${address}`);
      return true;
    } catch (error) {
      console.error('[PASSKEY] Error linking Farcaster:', error);
      return false;
    }
  }
}
