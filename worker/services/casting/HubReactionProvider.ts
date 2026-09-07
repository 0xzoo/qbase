/**
 * HubReactionProvider — likes / recasts via the hub protocol.
 *
 * Signs ReactionAdd / ReactionRemove with the FID's Ed25519 key (see
 * hubSignerLookup) and submits to /v1/submitMessage on the configured hub
 * (Haatz today, our own Hypersnap node later). No Neynar.
 */

import { HypersnapService } from '../HypersnapService';
import type { HubSigner } from './hubSignerLookup';
import type { ReactionPayload, ReactionProvider, ReactionResult } from './ReactionProvider';

export class HubReactionProvider implements ReactionProvider {
  readonly name = 'hub';

  private hub: HypersnapService;
  private signerLookup: (fid: number, env: any) => Promise<HubSigner | null>;

  constructor(opts: {
    hubEndpoint: string;
    signerLookup: (fid: number, env: any) => Promise<HubSigner | null>;
    fetchImpl?: typeof fetch;
  }) {
    this.hub = new HypersnapService({ endpoint: opts.hubEndpoint, fetchImpl: opts.fetchImpl });
    this.signerLookup = opts.signerLookup;
  }

  async canReact(fid: number, env: any): Promise<boolean> {
    return !!(await this.signerLookup(fid, env));
  }

  async add(payload: ReactionPayload, env: any): Promise<ReactionResult> {
    const signer = await this.requireSigner(payload.fid, env);
    const { hash } = await this.hub.publishReaction({
      signerKey: signer.key,
      fid: payload.fid,
      type: payload.type,
      targetHash: payload.targetHash,
      targetAuthorFid: payload.targetAuthorFid,
    });
    return { hash, provider: this.name };
  }

  async remove(payload: ReactionPayload, env: any): Promise<ReactionResult> {
    const signer = await this.requireSigner(payload.fid, env);
    await this.hub.removeReaction({
      signerKey: signer.key,
      fid: payload.fid,
      type: payload.type,
      targetHash: payload.targetHash,
      targetAuthorFid: payload.targetAuthorFid,
    });
    return { provider: this.name };
  }

  private async requireSigner(fid: number, env: any): Promise<HubSigner> {
    const signer = await this.signerLookup(fid, env);
    if (!signer) throw new Error(`No hub signer for FID ${fid}`);
    return signer;
  }
}
