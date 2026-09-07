/**
 * ReactionRouter — selects and dispatches to the right ReactionProvider.
 *
 * Mirror of CastRouter for likes / recasts (Track C card C6). Priority:
 *   1. HubReactionProvider     (bots; users from card C7)
 *   2. NeynarReactionProvider  (grandfathered Neynar user signers)
 *
 * The first provider whose canReact() is true handles the reaction; on
 * failure the next one is tried, so a hub hiccup for a user who also has a
 * Neynar signer still lands the like.
 */

import type { ReactionPayload, ReactionProvider, ReactionResult } from './ReactionProvider';
import { HubReactionProvider } from './HubReactionProvider';
import { NeynarReactionProvider } from './NeynarReactionProvider';
import { hubSignerLookup } from './hubSignerLookup';

export class ReactionRouter {
  private providers: ReactionProvider[];

  constructor(providers: ReactionProvider[]) {
    this.providers = providers;
  }

  /** True when at least one provider can react for this FID. */
  async canReact(fid: number, env: any): Promise<boolean> {
    for (const p of this.providers) {
      if (await p.canReact(fid, env)) return true;
    }
    return false;
  }

  add(payload: ReactionPayload, env: any): Promise<ReactionResult> {
    return this.dispatch('add', payload, env);
  }

  remove(payload: ReactionPayload, env: any): Promise<ReactionResult> {
    return this.dispatch('remove', payload, env);
  }

  listProviders(): string[] {
    return this.providers.map(p => p.name);
  }

  private async dispatch(op: 'add' | 'remove', payload: ReactionPayload, env: any): Promise<ReactionResult> {
    const errors: Array<{ provider: string; error: string }> = [];

    for (const provider of this.providers) {
      try {
        if (!(await provider.canReact(payload.fid, env))) {
          errors.push({ provider: provider.name, error: 'cannot react (no signer)' });
          continue;
        }
        console.log(`[ReactionRouter] ${op} ${payload.type} via ${provider.name} for FID ${payload.fid}`);
        return await provider[op](payload, env);
      } catch (err: any) {
        const msg = err?.message || String(err);
        console.warn(`[ReactionRouter] ${provider.name} failed for FID ${payload.fid}: ${msg}`);
        errors.push({ provider: provider.name, error: msg });
      }
    }

    const summary = errors.map(e => `${e.provider}: ${e.error}`).join('; ');
    throw new Error(`All reaction providers failed: ${summary}`);
  }
}

/**
 * Initialize the ReactionRouter with the current provider stack.
 * Hub first (HYPERSNAP_ENDPOINT, else HUB_ENDPOINT), Neynar as fallback.
 */
export function initReactionRouter(env: any): ReactionRouter {
  const providers: ReactionProvider[] = [];

  const hubEndpoint = env.HUB_ENDPOINT || env.HYPERSNAP_ENDPOINT;
  if (hubEndpoint) {
    providers.push(new HubReactionProvider({ hubEndpoint, signerLookup: hubSignerLookup }));
  }

  if (env.NEYNAR_API_KEY) {
    providers.push(new NeynarReactionProvider());
  }

  if (providers.length === 0) {
    throw new Error('No reaction providers configured. Set HUB_ENDPOINT or NEYNAR_API_KEY.');
  }

  return new ReactionRouter(providers);
}
