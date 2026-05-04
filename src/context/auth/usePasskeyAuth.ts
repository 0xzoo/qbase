/**
 * usePasskeyAuth — owns the passkey sign-in modal state and the hand-off
 * from PasskeySignInModal back to AuthContext's user state.
 *
 * Kept as its own hook so the AuthContext orchestrator doesn't have to
 * carry the (very small) passkey UI surface; lets PasskeyTest etc.
 * compose this directly if needed in the future.
 */
import { useCallback, useState } from 'react';
import type { User } from './types';

interface PasskeyAuthDeps {
  isMiniApp: boolean;
  setUser: (user: User) => void;
  fetchOwnProfile?: (token: string) => Promise<void> | void;
}

export interface PasskeyAuthHook {
  showPasskeyModal: boolean;
  loginWithPasskey: () => void;
  handlePasskeyAuth: (
    address: string,
    sessionToken: string,
    fid?: number | null,
    displayName?: string,
    pfpUrl?: string | null,
  ) => Promise<void>;
  closePasskeyModal: () => void;
}

export function usePasskeyAuth(deps: PasskeyAuthDeps): PasskeyAuthHook {
  const { isMiniApp, setUser, fetchOwnProfile } = deps;
  const [showPasskeyModal, setShowPasskeyModal] = useState(false);

  const loginWithPasskey = useCallback(() => {
    if (isMiniApp) return; // Passkeys are web/desktop only
    setShowPasskeyModal(true);
  }, [isMiniApp]);

  const handlePasskeyAuth = useCallback(async (
    address: string,
    sessionToken: string,
    fid?: number | null,
    displayName?: string,
    pfpUrl?: string | null,
  ) => {
    const passkeyUser: User = {
      username: displayName || `pk-${address.substring(0, 8)}`,
      fid: fid || undefined,
      displayName: displayName || 'Passkey User',
      pfpUrl: pfpUrl || `https://api.dicebear.com/7.x/identicon/svg?seed=${address}`,
      sessionToken,
      passkeyAddress: address,
    };
    setUser(passkeyUser);
    setShowPasskeyModal(false);

    // Native-profile fields (bio, native username, etc.) come from /api/users/me
    await fetchOwnProfile?.(sessionToken);

    console.log(`[AUTH] Passkey login successful: ${address} (FID: ${fid || 'none'})`);
  }, [setUser, fetchOwnProfile]);

  const closePasskeyModal = useCallback(() => {
    setShowPasskeyModal(false);
  }, []);

  return { showPasskeyModal, loginWithPasskey, handlePasskeyAuth, closePasskeyModal };
}
