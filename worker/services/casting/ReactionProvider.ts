/**
 * ReactionProvider — abstract interface for likes / recasts on Farcaster.
 *
 * Mirrors CastProvider (Track C card C6). Implementations:
 *   - HubReactionProvider     (hub protocol via FarcasterHubWriter — bots and,
 *                              from card C7, users with a hub signer)
 *   - NeynarReactionProvider  (Neynar REST — grandfathered Neynar user signers)
 *
 * Route handlers call ReactionRouter.add() / remove() instead of branching on
 * provider type.
 */

export interface ReactionPayload {
  /** FID reacting. */
  fid: number;
  type: 'like' | 'recast';
  /** Cast being reacted to (0x hex). */
  targetHash: string;
  /** Author of the target cast; the hub addresses casts by fid + hash. */
  targetAuthorFid: number;
}

export interface ReactionResult {
  /** Reaction message hash when the provider returns one (hub); undefined for Neynar. */
  hash?: string;
  /** Which provider actually published this reaction */
  provider: string;
}

export interface ReactionProvider {
  readonly name: string;

  /** Can this provider react on behalf of `fid` right now? (signer available) */
  canReact(fid: number, env: any): Promise<boolean>;

  /** Add a reaction. Throws on failure. */
  add(payload: ReactionPayload, env: any): Promise<ReactionResult>;

  /** Remove a reaction. Throws on failure. */
  remove(payload: ReactionPayload, env: any): Promise<ReactionResult>;
}
