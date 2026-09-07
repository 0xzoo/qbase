/**
 * FarcasterDataProvider — one interface for every Farcaster *read* qbase makes
 * that is not a cast (casting is `services/casting/`).
 *
 * Track C1 (docs/plans/wave-governance-roadmap.md, decision 13): Neynar becomes
 * one provider among several. Call sites talk to `FarcasterDataRouter`, never to
 * `api.neynar.com` directly, so swapping Neynar for our own hub is a change in
 * `initFarcasterData()`, not in fifteen route handlers.
 *
 * Implementations:
 *   - NeynarDataProvider  (REST; the only source for score, pro, address→FID,
 *                          channel search, best friends, viewer context)
 *   - HubDataProvider     (hub HTTP API: userDataByFid, verificationsByFid,
 *                          userNameProofByName; HUB_ENDPOINT — Haatz today,
 *                          our own node later)
 *
 * The user shape mirrors Neynar's wire format for the fields both sources can
 * fill, so the client (`src/pages/ProfilePage.tsx`) and the KV profile caches
 * keep working unchanged whichever provider answered.
 */

export interface FarcasterUser {
  fid: number;
  username?: string;
  display_name?: string;
  pfp_url?: string;
  custody_address?: string;
  profile?: { bio?: { text?: string } };
  follower_count?: number;
  following_count?: number;
  verified_addresses?: {
    eth_addresses?: string[];
    sol_addresses?: string[];
    primary?: { eth_address?: string | null; sol_address?: string | null };
  };
  /** Neynar-only: proprietary quality score in [0, 1]. Undefined from a hub. */
  score?: number;
  /** Neynar-only: Warpcast power badge. Undefined from a hub. */
  power_badge?: boolean;
  /** Neynar-only: Farcaster Pro subscription. Undefined from a hub. */
  pro?: { status: 'subscribed' | 'unsubscribed'; subscribed_at?: string; expires_at?: string };
  /** Present only when `viewerFid` was passed and the provider supports it. */
  viewer_context?: { following: boolean; followed_by: boolean };
  /** Which provider produced this record. */
  provider: string;
}

export interface FarcasterChannel {
  id: string;
  url: string;
  name: string;
  description?: string;
  image_url?: string;
  follower_count?: number;
  lead?: { fid: number; username: string; display_name: string; pfp_url?: string };
}

export interface GetUsersOptions {
  /** Ask for the relationship between each returned user and this FID. */
  viewerFid?: number;
}

/**
 * A data source. `getUsers` is the only required method; the rest are
 * capabilities a provider may or may not have. The router skips providers
 * that lack a capability and moves to the next one.
 */
export interface FarcasterDataProvider {
  readonly name: string;

  /** Users by FID. Missing FIDs are simply absent from the result. */
  getUsers(fids: number[], opts?: GetUsersOptions): Promise<FarcasterUser[]>;

  /** Exact username (fname) lookup. */
  getUserByUsername?(username: string): Promise<FarcasterUser | null>;

  /** Reverse lookup: which FIDs own any of these addresses (verified or custody). */
  getFidsByAddresses?(addresses: string[]): Promise<number[]>;

  /** Channel search by free text. */
  searchChannels?(query: string, limit: number): Promise<FarcasterChannel[]>;

  /** Top mutual-affinity accounts for a FID ("besties"). */
  getBestFriends?(fid: number, limit: number): Promise<number[]>;
}

/** Thrown by the router when no configured provider can answer a request. */
export class NoProviderError extends Error {
  constructor(capability: string) {
    super(`No Farcaster data provider can ${capability}`);
    this.name = 'NoProviderError';
  }
}
