/**
 * CastRouter — selects and dispatches to the right CastProvider.
 *
 * Replaces the if/else branching in farcaster.ts with a priority-ordered
 * provider list. The first provider that canPublish() wins.
 *
 * Current priority (Option A — Snapchain-first):
 *   1. SnapchainCastProvider  (primary — same hub protocol, no Neynar dep on writes)
 *   2. NeynarCastProvider     (fallback — grandfathered Neynar signers)
 *   3. HypersnapCastProvider  (future — non-Farcaster user onboarding)
 *
 * Adding a new provider = add it to the list + register in initCastRouter().
 * No route handler changes needed.
 */

import type { CastProvider, CastPayload, CastResult } from './CastProvider';
import { NeynarCastProvider } from './NeynarCastProvider';
import { SnapchainCastProvider, snapchainSignerLookup } from './SnapchainCastProvider';
// Uncomment when activating Hypersnap for new user onboarding:
// import { HypersnapCastProvider } from './HypersnapCastProvider';

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export class CastRouter {
  private providers: CastProvider[];
  private fallbackToNext: boolean;

  constructor(providers: CastProvider[], opts?: { fallbackToNext?: boolean }) {
    this.providers = providers;
    this.fallbackToNext = opts?.fallbackToNext ?? true;
  }

  /**
   * Publish a cast using the first available provider.
   *
   * If fallbackToNext is true (default), tries the next provider on failure.
   * This gives resilience — if Snapchain hub is down, Neynar catches it.
   *
   * If false, throws immediately on the first provider's failure.
   * Use false when you want strict provider pinning (e.g. "this user MUST
   * go through Snapchain").
   */
  async publish(payload: CastPayload, env: any): Promise<CastResult> {
    const errors: Array<{ provider: string; error: string }> = [];

    for (const provider of this.providers) {
      try {
        const can = await provider.canPublish(payload.fid, env);
        if (!can) {
          errors.push({ provider: provider.name, error: 'cannot publish (no signer)' });
          continue;
        }

        console.log(`[CastRouter] Publishing via ${provider.name} for FID ${payload.fid}`);
        const result = await provider.publish(payload, env);

        if (errors.length > 0) {
          console.log(
            `[CastRouter] ${provider.name} succeeded after ${errors.length} skipped:`,
            errors.map(e => e.provider).join(', ')
          );
        }

        return result;
      } catch (err: any) {
        const msg = err?.message || String(err);
        console.warn(`[CastRouter] ${provider.name} failed for FID ${payload.fid}: ${msg}`);
        errors.push({ provider: provider.name, error: msg });

        if (!this.fallbackToNext) {
          throw err;
        }
      }
    }

    // All providers exhausted.
    const summary = errors.map(e => `${e.provider}: ${e.error}`).join('; ');
    throw new Error(`All cast providers failed: ${summary}`);
  }

  /**
   * List registered providers (for debugging/admin).
   */
  listProviders(): string[] {
    return this.providers.map(p => p.name);
  }
}

// ---------------------------------------------------------------------------
// Factory — called once in the route handler
// ---------------------------------------------------------------------------

/**
 * Initialize the CastRouter with the current provider stack.
 *
 * Swap provider order or add/remove providers here. The route handler
 * calls this and then router.publish() — it doesn't know or care which
 * backend is active.
 */
export function initCastRouter(env: any): CastRouter {
  const providers: CastProvider[] = [];

  // 1. Snapchain — primary write path for existing Farcaster users.
  //    Uses FarcasterHubWriter + Snapchain hub endpoint.
  const snapchainEndpoint = env.SNAPCHAIN_HUB_ENDPOINT;
  if (snapchainEndpoint) {
    providers.push(
      new SnapchainCastProvider({
        hubEndpoint: snapchainEndpoint,
        signerLookup: snapchainSignerLookup,
      })
    );
  }

  // 2. Neynar — fallback for grandfathered signers.
  //    Once all signers are migrated to Snapchain, this can be removed.
  if (env.NEYNAR_API_KEY) {
    providers.push(new NeynarCastProvider());
  }

  // 3. Hypersnap — uncomment when onboarding non-Farcaster users.
  // const hypersnapEndpoint = env.HYPERSNAP_ENDPOINT;
  // if (hypersnapEndpoint) {
  //   providers.push(
  //     new HypersnapCastProvider({
  //       hubEndpoint: hypersnapEndpoint,
  //       signerLookup: async (fid, _env) => {
  //         // Hypersnap-native FID signer lookup (TBD)
  //         return null;
  //       },
  //     })
  //   );
  // }

  if (providers.length === 0) {
    throw new Error('No cast providers configured. Set SNAPCHAIN_HUB_ENDPOINT or NEYNAR_API_KEY.');
  }

  return new CastRouter(providers, { fallbackToNext: true });
}
