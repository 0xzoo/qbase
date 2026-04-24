/**
 * CastProvider — abstract interface for publishing casts to Farcaster.
 *
 * Implementations:
 *   - NeynarCastProvider    (Neynar REST API — current user/bot signing)
 *   - SnapchainCastProvider (Snapchain hub protocol — main target)
 *   - HypersnapCastProvider (Hypersnap hub protocol — future, new users)
 *
 * The route handler calls CastRouter.publish() instead of branching on
 * provider type. This keeps farcaster.ts clean and makes adding/removing
 * backends a config change, not a code change.
 */

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface CastPayload {
  fid: number;
  text: string;
  embeds?: Array<{ url: string }>;
  parentHash?: string;
  parentAuthorFid?: number;
}

export interface CastResult {
  hash: string;
  author_fid: number;
  text: string;
  /** Which provider actually published this cast */
  provider: string;
}

export interface SignerInfo {
  fid: number;
  signer_key: string;       // Neynar signer_uuid OR Ed25519 public key hex
  provider: string;         // 'neynar' | 'snapchain' | 'hypersnap'
  status: 'pending' | 'approved' | 'revoked';
}

// ---------------------------------------------------------------------------
// CastProvider interface
// ---------------------------------------------------------------------------

export interface CastProvider {
  readonly name: string;

  /** Can this provider handle the cast right now? (signer approved, hub reachable) */
  canPublish(fid: number, env: any): Promise<boolean>;

  /** Publish a cast. Throws on failure. */
  publish(payload: CastPayload, env: any): Promise<CastResult>;
}

// ---------------------------------------------------------------------------
// SignerProvider interface (for signer lifecycle — create, lookup, revoke)
// ---------------------------------------------------------------------------

export interface SignerProvider {
  readonly name: string;

  /** Create a new signer for an FID. Returns signer info + approval URL if needed. */
  createSigner(fid: number, env: any): Promise<SignerInfo & { approval_url?: string }>;

  /** Check signer status (poll for approval, detect revocation). */
  lookupSigner(signerKey: string, env: any): Promise<SignerInfo>;

  /** Revoke a signer. */
  revokeSigner(signerKey: string, env: any): Promise<void>;
}
