/**
 * Shared types for AuthContext and the per-mode hooks under src/context/auth/.
 */

export interface User {
  username?: string;
  fid?: number;
  pfpUrl?: string;
  displayName?: string;
  bio?: string; // Native profile bio
  profileSource?: string; // 'farcaster' | 'native' | 'passkey'
  quickAuthToken?: string; // JWT from Quick Auth (MiniApp)
  sessionToken?: string; // Session token from SIWF or passkey exchange (Web)
  passkeyAddress?: string; // Quilibrium passkey address (for passkey auth)
}
