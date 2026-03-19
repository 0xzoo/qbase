/**
 * Passkey Authentication Service
 * 
 * Handles passkey user creation, registration storage, and session management.
 * Passkey users are identified by their Quilibrium address (Qm...).
 * Sessions use the same KV mechanism as Farcaster sessions.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

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
  publicKey: string;
  displayName?: string;
  credentialId: string;
  registrationData: unknown; // Will be JSON.stringified
  deviceName?: string;
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

    if (!existing) {
      // Create new passkey user
      await env.DB.prepare(`
        INSERT INTO passkey_users (address, public_key, display_name, created_at, last_login_at)
        VALUES (?, ?, ?, ?, ?)
      `).bind(
        params.address,
        params.publicKey,
        params.displayName || null,
        now,
        now
      ).run();

      isNewUser = true;
      console.log(`[PASSKEY] ✅ Created new user: ${params.address}`);
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

    // Create session
    const sessionToken = crypto.randomUUID();
    const expiresAt = now + (30 * 24 * 60 * 60 * 1000); // 30 days (longer than Farcaster's 7)

    await env.KV_USER_PROFILES.put(
      `session:${sessionToken}`,
      JSON.stringify({ passkeyAddress: params.address, expiresAt }),
      { expirationTtl: 30 * 24 * 60 * 60 } // 30 days
    );

    console.log(`[PASSKEY] ✅ Created session for ${params.address}`);

    return { sessionToken, address: params.address, isNewUser };
  }

  /**
   * Login: verify the user exists and create a new session.
   * For now we trust the WebAuthn ceremony (browser-side verification).
   * Future: add server-side Ed448 signature verification.
   */
  static async login(
    env: Env,
    address: string
  ): Promise<{ sessionToken: string; address: string } | null> {
    const now = Date.now();

    // Check user exists
    const user = await env.DB.prepare(
      'SELECT address FROM passkey_users WHERE address = ?'
    ).bind(address).first();

    if (!user) {
      console.warn(`[PASSKEY] Login attempt for unknown address: ${address}`);
      return null;
    }

    // Update last login
    await env.DB.prepare(
      'UPDATE passkey_users SET last_login_at = ? WHERE address = ?'
    ).bind(now, address).run();

    // Create session
    const sessionToken = crypto.randomUUID();
    const expiresAt = now + (30 * 24 * 60 * 60 * 1000);

    await env.KV_USER_PROFILES.put(
      `session:${sessionToken}`,
      JSON.stringify({ passkeyAddress: address, expiresAt }),
      { expirationTtl: 30 * 24 * 60 * 60 }
    );

    console.log(`[PASSKEY] ✅ Login session created for ${address}`);
    return { sessionToken, address };
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
