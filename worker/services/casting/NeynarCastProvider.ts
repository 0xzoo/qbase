/**
 * NeynarCastProvider — publishes casts via Neynar REST API.
 *
 * Wraps the existing NeynarSignerService. This is the current production
 * path for both bot and user casts. It stays as a fallback even after
 * Snapchain signers are primary, because some signers may still be
 * Neynar-managed (grandfathered).
 */

import { NeynarSignerService } from '../NeynarSignerService';
import type { CastProvider, CastPayload, CastResult } from './CastProvider';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createNeynarService(env: any): NeynarSignerService {
  // Route to the right API key based on context.
  // User casts: NEYNAR_API_KEY. Bot casts: caller passes the right key.
  const apiKey = env.NEYNAR_API_KEY;
  if (!apiKey) throw new Error('NEYNAR_API_KEY not configured');
  return new NeynarSignerService(apiKey);
}

/** The NeynarSignerService for a FID: a bot's dedicated key when it has one, else the app key. */
export function neynarSignerServiceFor(env: any, fid: number): NeynarSignerService {
  const isBot = fid === (Number(env.ANON_FID) || 514282) ||
                fid === (Number(env.QGENT_FID) || 975961) ||
                fid === (Number(env.POLLS_FID) || 3321680);
  return isBot ? createBotNeynarService(env, fid) : createNeynarService(env);
}

function createBotNeynarService(env: any, fid: number): NeynarSignerService {
  // Bot FIDs may have dedicated API keys for rate limit isolation.
  const keyMap: Record<number, string> = {
    [Number(env.ANON_FID) || 514282]: env.NEYNAR_ANON_BOT_API_KEY || env.NEYNAR_API_KEY,
    [Number(env.QGENT_FID) || 975961]: env.QGENT_NEYNAR_API_KEY || env.NEYNAR_API_KEY,
    [Number(env.POLLS_FID) || 3321680]: env.NEYNAR_API_KEY,  // polls bot uses standard key
  };
  const apiKey = keyMap[fid] || env.NEYNAR_API_KEY;
  if (!apiKey) throw new Error('NEYNAR_API_KEY not configured');
  return new NeynarSignerService(apiKey);
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class NeynarCastProvider implements CastProvider {
  readonly name = 'neynar';

  async canPublish(fid: number, env: any): Promise<boolean> {
    // Check D1 for an approved Neynar signer for this FID.
    // Filter by provider='neynar' to avoid picking up Snapchain/Hypersnap signers.
    try {
      const row = await env.DB.prepare(
        "SELECT signer_uuid FROM user_signers WHERE fid = ? AND status = 'approved' AND provider = 'neynar' ORDER BY updated_at DESC LIMIT 1"
      ).bind(fid).first();
      return !!row;
    } catch {
      return false;
    }
  }

  async publish(payload: CastPayload, env: any): Promise<CastResult> {
    // Resolve the approved signer UUID from D1.
    const row = await env.DB.prepare(
      "SELECT signer_uuid FROM user_signers WHERE fid = ? AND status = 'approved' AND provider = 'neynar' ORDER BY updated_at DESC LIMIT 1"
    ).bind(payload.fid).first() as { signer_uuid: string } | null;

    if (!row) {
      throw new Error(`No approved Neynar signer for FID ${payload.fid}`);
    }

    // Pick the right Neynar API key (bot vs user).
    const service = neynarSignerServiceFor(env, payload.fid);

    const result = await service.publishCast({
      signerUuid: row.signer_uuid,
      text: payload.text,
      embeds: payload.embeds,
      parent: payload.parentHash,
      parentAuthorFid: payload.parentAuthorFid,
    });

    return {
      hash: result.hash,
      author_fid: result.author_fid,
      text: result.text,
      provider: this.name,
    };
  }
}
