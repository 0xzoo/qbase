/**
 * Signer Service - Database operations for user signers
 * Manages persistence of Neynar signer UUIDs in D1 database
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

export interface UserSigner {
  id: number;
  fid: number;
  signer_uuid: string;
  public_key: string;
  status: 'pending_approval' | 'approved' | 'revoked';
  created_at: string;
  updated_at: string;
}

export class SignerService {
  /**
   * Save a signer to the database
   */
  static async saveSigner(
    env: Env,
    fid: number,
    signerUuid: string,
    publicKey: string,
    status: 'pending_approval' | 'approved' | 'revoked' = 'pending_approval',
    provider: string = 'neynar'
  ): Promise<UserSigner> {
    try {
      // Upsert: insert or update if UUID already exists
      await env.DB.prepare(`
        INSERT INTO user_signers (fid, signer_uuid, public_key, status, provider, updated_at)
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(signer_uuid) DO UPDATE SET
          status = excluded.status,
          provider = excluded.provider,
          updated_at = CURRENT_TIMESTAMP
      `).bind(fid, signerUuid, publicKey, status, provider).run();

      // Fetch the saved signer
      const result = await env.DB.prepare(`
        SELECT * FROM user_signers WHERE signer_uuid = ?
      `).bind(signerUuid).first();

      if (!result) {
        throw new Error('Failed to save signer');
      }

      return this.parseSigner(result);
    } catch (error) {
      console.error('Error saving signer:', error);
      throw error;
    }
  }

  /**
   * Get all signers for a user by FID (excludes revoked signers)
   */
  static async getSignersByFid(env: Env, fid: number): Promise<UserSigner[]> {
    try {
      const results = await env.DB.prepare(`
        SELECT * FROM user_signers
        WHERE fid = ? AND status != 'revoked'
        ORDER BY created_at DESC
      `).bind(fid).all();

      return results.results.map((row: any) => this.parseSigner(row));
    } catch (error) {
      console.error('Error fetching signers:', error);
      return [];
    }
  }

  /**
   * Get a specific signer by UUID
   */
  static async getSignerByUuid(env: Env, signerUuid: string): Promise<UserSigner | null> {
    try {
      const result = await env.DB.prepare(`
        SELECT * FROM user_signers WHERE signer_uuid = ?
      `).bind(signerUuid).first();

      if (!result) {
        return null;
      }

      return this.parseSigner(result);
    } catch (error) {
      console.error('Error fetching signer:', error);
      return null;
    }
  }

  /**
   * Update signer status
   * If status is 'approved', automatically revokes all other pending signers for that FID
   */
  static async updateSignerStatus(
    env: Env,
    signerUuid: string,
    status: 'pending_approval' | 'approved' | 'revoked'
  ): Promise<void> {
    try {
      // Update the signer status
      await env.DB.prepare(`
        UPDATE user_signers
        SET status = ?, updated_at = CURRENT_TIMESTAMP
        WHERE signer_uuid = ?
      `).bind(status, signerUuid).run();

      // If approving a signer, revoke all other pending signers for this user
      if (status === 'approved') {
        const signer = await this.getSignerByUuid(env, signerUuid);
        if (signer) {
          await env.DB.prepare(`
            UPDATE user_signers
            SET status = 'revoked', updated_at = CURRENT_TIMESTAMP
            WHERE fid = ? AND signer_uuid != ? AND status = 'pending_approval'
          `).bind(signer.fid, signerUuid).run();
        }
      }
    } catch (error) {
      console.error('Error updating signer status:', error);
      throw error;
    }
  }

  /**
   * Delete a signer
   */
  static async deleteSigner(env: Env, signerUuid: string): Promise<void> {
    try {
      await env.DB.prepare(`
        DELETE FROM user_signers WHERE signer_uuid = ?
      `).bind(signerUuid).run();
    } catch (error) {
      console.error('Error deleting signer:', error);
      throw error;
    }
  }

  /**
   * Parse database row into UserSigner object
   */
  private static parseSigner(row: any): UserSigner {
    return {
      id: row.id,
      fid: row.fid,
      signer_uuid: row.signer_uuid,
      public_key: row.public_key,
      status: row.status as 'pending_approval' | 'approved' | 'revoked',
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}

