/**
 * casting/ — pluggable cast provider system for Farcaster writes.
 *
 * Usage:
 *   import { CastRouter, initCastRouter } from '../services/casting';
 *   const router = initCastRouter(env);
 *   const result = await router.publish({ fid, text, embeds }, env);
 *
 * Adding a new provider:
 *   1. Implement CastProvider interface in YourProvider.ts
 *   2. Add to initCastRouter() in CastRouter.ts
 *   3. Done — no route handler changes.
 *
 * Reactions (likes / recasts) follow the same shape:
 *   const reactions = initReactionRouter(env);
 *   await reactions.add({ fid, type: 'like', targetHash, targetAuthorFid }, env);
 */

export type { CastProvider, CastPayload, CastResult, SignerInfo } from './CastProvider';
export { CastRouter, initCastRouter } from './CastRouter';
export { NeynarCastProvider } from './NeynarCastProvider';
export { SnapchainCastProvider, snapchainSignerLookup } from './SnapchainCastProvider';
export { HypersnapCastProvider } from './HypersnapCastProvider';

export type { ReactionProvider, ReactionPayload, ReactionResult } from './ReactionProvider';
export { ReactionRouter, initReactionRouter } from './ReactionRouter';
export { HubReactionProvider } from './HubReactionProvider';
export { NeynarReactionProvider } from './NeynarReactionProvider';
export { hubSignerLookup } from './hubSignerLookup';
export type { HubSigner } from './hubSignerLookup';
