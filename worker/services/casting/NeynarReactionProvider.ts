/**
 * NeynarReactionProvider — likes / recasts via Neynar REST with the FID's
 * approved Neynar signer (`user_signers.provider = 'neynar'`).
 *
 * The grandfathered path: users who approved a signer through SIWN keep
 * reacting through Neynar until card C7 moves them to hub signers.
 */

import { neynarSignerServiceFor } from './NeynarCastProvider';
import type { ReactionPayload, ReactionProvider, ReactionResult } from './ReactionProvider';

const SIGNER_SQL =
  "SELECT signer_uuid FROM user_signers WHERE fid = ? AND status = 'approved' AND provider = 'neynar' ORDER BY updated_at DESC LIMIT 1";

export class NeynarReactionProvider implements ReactionProvider {
  readonly name = 'neynar';

  async canReact(fid: number, env: any): Promise<boolean> {
    if (!env.NEYNAR_API_KEY) return false;
    try {
      return !!(await env.DB.prepare(SIGNER_SQL).bind(fid).first());
    } catch {
      return false;
    }
  }

  async add(payload: ReactionPayload, env: any): Promise<ReactionResult> {
    const signerUuid = await this.requireSigner(payload.fid, env);
    await neynarSignerServiceFor(env, payload.fid).publishReaction({
      signerUuid,
      reactionType: payload.type,
      targetCastHash: payload.targetHash,
    });
    return { provider: this.name };
  }

  async remove(payload: ReactionPayload, env: any): Promise<ReactionResult> {
    const signerUuid = await this.requireSigner(payload.fid, env);
    await neynarSignerServiceFor(env, payload.fid).removeReaction({
      signerUuid,
      reactionType: payload.type,
      targetCastHash: payload.targetHash,
    });
    return { provider: this.name };
  }

  private async requireSigner(fid: number, env: any): Promise<string> {
    const row = await env.DB.prepare(SIGNER_SQL).bind(fid).first() as { signer_uuid: string } | null;
    if (!row) throw new Error(`No approved Neynar signer for FID ${fid}`);
    return row.signer_uuid;
  }
}
