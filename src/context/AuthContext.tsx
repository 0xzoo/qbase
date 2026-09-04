import React, { createContext, useContext, useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { ReactNode } from 'react';
import { sdk } from '@farcaster/miniapp-sdk';
import { apiClient } from '../lib/apiClient';
import { useFarcasterMiniAppAuth, resetMiniAppStatusFetched } from './auth/useFarcasterMiniAppAuth';
import { usePasskeyAuth } from './auth/usePasskeyAuth';
import { useFarcasterWebAuth } from './auth/useFarcasterWebAuth';
import type { User } from './auth/types';

interface AuthContextType {
  user: User | null;
  isAuthenticated: boolean;
  isMiniApp: boolean;
  miniAppAdded: boolean;
  notificationsEnabled: boolean;
  isLoading: boolean;
  login: () => void;
  logout: () => void;
  setUserData: (userData: Partial<User>) => void;
  getAuthToken: () => string | null;
  addMiniApp: () => Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handleWebAuth: (res: any) => Promise<void>;
  authUrl: string | undefined;
  isAuthPolling: boolean;
  cancelAuth: () => void;
  showPasskeyModal: boolean;
  loginWithPasskey: () => void;
  handlePasskeyAuth: (address: string, sessionToken: string, fid?: number | null, displayName?: string, pfpUrl?: string | null) => void;
  closePasskeyModal: () => void;
  needsOnboarding: boolean;
  fetchOwnProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(() => {
    try {
      const saved = localStorage.getItem('fc_user');
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  });
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [needsOnboarding, setNeedsOnboarding] = useState(false);

  // Per-mode auth hooks. user/setUser stays in this orchestrator; each
  // hook owns its own slice of state and writes to the shared user via
  // setUser.
  const { isMiniApp, miniAppAdded, notificationsEnabled, addMiniApp } =
    useFarcasterMiniAppAuth({ setUser, setIsLoading, user });

  // fetchOwnProfileRef bridges the forward reference: registerUser /
  // exchangeSiwfForSession need to call fetchOwnProfile, but
  // fetchOwnProfileInternal depends on getAuthToken (which depends on
  // user, which depends on the hooks below). The ref is wired by the
  // useEffect at the bottom.
  const fetchOwnProfileRef = useRef<((tokenOverride?: string) => Promise<void>) | null>(null);
  const passkeyFetchOwnProfile = useCallback(async (token: string) => {
    await fetchOwnProfileRef.current?.(token);
  }, []);

  const { showPasskeyModal, loginWithPasskey, handlePasskeyAuth, closePasskeyModal } =
    usePasskeyAuth({ isMiniApp, setUser, fetchOwnProfile: passkeyFetchOwnProfile });

  const registerUser = useCallback(async (
    userData: { fid: number; username: string; displayName?: string; pfpUrl?: string },
    token?: string, // JWT (MiniApp) or session token (Web)
  ) => {
    try {
      const headers: HeadersInit = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const response = await fetch('/api/users', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          fid: userData.fid,
          fname: userData.username,
          displayName: userData.displayName,
          pfpUrl: userData.pfpUrl,
        }),
      });

      if (response.ok) {
        const result = await response.json();
        return result.user;
      }
      const error = await response.text();
      console.error('[AUTH] Failed to register user:', {
        status: response.status,
        statusText: response.statusText,
        error,
      });
    } catch (error) {
      console.error('[AUTH] Error registering user:', error);
    }
  }, []);

  const {
    login: webLogin,
    logout: webLogout,
    cancelAuth,
    handleWebAuth,
    authUrl,
    isAuthPolling,
    clearSessionExchangeMutex,
  } = useFarcasterWebAuth({
    isMiniApp,
    user,
    setUser,
    registerUser,
    fetchOwnProfile: passkeyFetchOwnProfile,
  });

  // Persist user to localStorage whenever it changes
  useEffect(() => {
    if (user) {
      localStorage.setItem('fc_user', JSON.stringify(user));
    } else {
      localStorage.removeItem('fc_user');
    }
  }, [user]);

  // Hook up apiClient with auth token getter
  useEffect(() => {
    apiClient.setSIWFCredentialsGetter(() => {
      if (user) {
        return {
          sessionToken: user.sessionToken,
          quickAuthToken: user.quickAuthToken,
        };
      }
      // Fallback: covers the race between setUser() and the apiClient
      // getter closure update (React async state vs synchronous fetches).
      const passkeyToken = localStorage.getItem('passkey_session_token');
      if (passkeyToken) {
        return { sessionToken: passkeyToken };
      }
      return null;
    });
  }, [user?.sessionToken, user?.quickAuthToken, user]);

  // 401 handler — automatic logout on session expiry
  useEffect(() => {
    apiClient.setOnUnauthorized(() => {
      console.log('[AUTH] Session expired - logging out automatically');
      setUser(null);
      localStorage.removeItem('fc_user');
      localStorage.removeItem('passkey_session_token');
      Object.keys(localStorage).forEach(key => {
        if (key.startsWith('fc.') || key.startsWith('@farcaster')) {
          localStorage.removeItem(key);
        }
      });
      resetMiniAppStatusFetched();
      clearSessionExchangeMutex();
    });
  }, [clearSessionExchangeMutex]);

  // Restore session from localStorage on mount (web only — miniapp gets
  // restored via Quick Auth in useFarcasterMiniAppAuth).
  useEffect(() => {
    if (!isMiniApp && !isLoading) {
      const savedUser = localStorage.getItem('fc_user');
      if (savedUser) {
        try {
          const userData = JSON.parse(savedUser);
          if (!userData.sessionToken) {
            localStorage.removeItem('fc_user');
            setUser(null);
          }
        } catch (error) {
          console.error('[AUTH] Failed to parse saved user:', error);
          localStorage.removeItem('fc_user');
          setUser(null);
        }
      }
    }
  }, [isMiniApp, isLoading, user]);

  // Guard against double-click → double Quick-Auth on the miniapp branch.
  // The web branch has its own equivalent guard inside useFarcasterWebAuth.
  const miniAppAuthInFlight = useRef(false);
  const login = useCallback(async () => {
    if (isMiniApp) {
      if (miniAppAuthInFlight.current) return;
      miniAppAuthInFlight.current = true;
      try {
        const { token } = await sdk.quickAuth.getToken();
        const context = await sdk.context;
        if (context && context.user) {
          setUser({
            username: context.user.username,
            fid: context.user.fid,
            pfpUrl: context.user.pfpUrl,
            displayName: context.user.displayName,
            quickAuthToken: token,
          });
          await registerUser({
            fid: context.user.fid,
            username: context.user.username,
            displayName: context.user.displayName,
            pfpUrl: context.user.pfpUrl,
          }, token);
        }
      } catch (e) {
        console.error('MiniApp Quick Auth login failed', e);
      } finally {
        miniAppAuthInFlight.current = false;
      }
    } else {
      await webLogin();
    }
  }, [isMiniApp, registerUser, webLogin]);

  const logout = useCallback(() => {
    if (isMiniApp) {
      setUser(null);
      resetMiniAppStatusFetched();
    } else {
      webLogout();
      setUser(null);
      localStorage.removeItem('fc_user');
      localStorage.removeItem('passkey_session_token');
      localStorage.removeItem('onboarding_complete');
      // Intentionally do NOT remove 'qbase-passkeys' here — it holds the
      // user's Ed448 private key (PRF-wrapped on supported browsers).
      // Passkeys are a *re-auth credential*, not session state, and
      // wiping them strands the user: the WebAuthn credential + server
      // public key both survive logout, but without the local Ed448
      // there's no way to sign the next /api/auth/passkey/login
      // challenge. PasskeySignInModal exposes "Clear passkey & create
      // new" for the rare cases where a forced reset is needed.
      resetMiniAppStatusFetched();
      setNeedsOnboarding(false);
      console.log('[AUTH] Logged out (passkey credential preserved)');
    }
  }, [isMiniApp, webLogout]);

  const setUserData = useCallback((userData: Partial<User>) => {
    setUser(prevUser => ({
      ...prevUser,
      ...userData,
    } as User));
  }, []);

  const getAuthToken = useCallback((): string | null => {
    if (isMiniApp && user?.quickAuthToken) {
      return user.quickAuthToken;
    }
    if (user?.sessionToken) {
      return user.sessionToken;
    }
    return null;
  }, [isMiniApp, user?.quickAuthToken, user?.sessionToken]);

  // Fetch own profile from backend to get stored native identity data
  const fetchOwnProfileInternal = useCallback(async (tokenOverride?: string) => {
    const token = tokenOverride || getAuthToken();
    if (!token) return;

    try {
      // If we have an explicit token override, bypass apiClient which may
      // have a stale closure over `user` state (React async updates).
      const res: Response = tokenOverride
        ? await fetch('/api/users/me', {
            headers: { 'Authorization': `Bearer ${token}` },
          })
        : await apiClient.get('/api/users/me');
      if (!res.ok) {
        console.log('[AUTH] Profile fetch returned', res.status);
        return;
      }

      const data = await res.json() as { user: {
        username: string | null;
        display_name: string | null;
        pfp_url: string | null;
        bio: string | null;
        profile_source: string | null;
      }};
      const profile = data.user;

      setUser(prev => {
        if (!prev) return prev;
        return {
          ...prev,
          username: profile.username || prev.username,
          displayName: profile.display_name || prev.displayName,
          pfpUrl: profile.pfp_url || prev.pfpUrl,
          bio: profile.bio ?? prev.bio,
          profileSource: profile.profile_source ?? prev.profileSource,
        };
      });

      const onboardingComplete = localStorage.getItem('onboarding_complete') === 'true';
      // Farcaster users already have identity — no onboarding needed
      if (profile?.profile_source === 'farcaster' || profile?.profile_source === 'farcaster-connect') {
        localStorage.setItem('onboarding_complete', 'true');
        setNeedsOnboarding(false);
      } else if (!profile?.username && !onboardingComplete) {
        setNeedsOnboarding(true);
      } else {
        setNeedsOnboarding(false);
      }
    } catch (error) {
      console.error('[AUTH] Failed to fetch own profile:', error);
    }
  }, [getAuthToken]);

  // Wire the ref so registerUser / exchangeSiwfForSession can call into
  // fetchOwnProfileInternal even though it's defined after them.
  useEffect(() => {
    fetchOwnProfileRef.current = fetchOwnProfileInternal;
  }, [fetchOwnProfileInternal]);

  // Recompute onboarding need on user change
  useEffect(() => {
    if (!user) {
      setNeedsOnboarding(false);
      return;
    }

    if (user.profileSource === 'farcaster' || user.profileSource === 'farcaster-connect') {
      if (typeof window !== 'undefined') {
        localStorage.setItem('onboarding_complete', 'true');
      }
      setNeedsOnboarding(false);
      return;
    }

    if (user.fid && (user.sessionToken || user.quickAuthToken)) {
      if (typeof window !== 'undefined') {
        localStorage.setItem('onboarding_complete', 'true');
      }
      setNeedsOnboarding(false);
      return;
    }

    if (user.profileSource) {
      setNeedsOnboarding(!user.username);
      return;
    }

    const onboardingComplete = typeof window !== 'undefined'
      && localStorage.getItem('onboarding_complete') === 'true';

    if (!user.sessionToken && !user.quickAuthToken) return;

    if (!user.username && !onboardingComplete) {
      setNeedsOnboarding(true);
    }
  }, [user]);

  const contextValue = useMemo<AuthContextType>(() => ({
    user,
    isAuthenticated: !!user,
    isMiniApp,
    miniAppAdded,
    notificationsEnabled,
    isLoading,
    login,
    logout,
    setUserData,
    getAuthToken,
    addMiniApp,
    handleWebAuth,
    authUrl,
    isAuthPolling,
    cancelAuth,
    showPasskeyModal,
    loginWithPasskey,
    handlePasskeyAuth,
    closePasskeyModal,
    needsOnboarding,
    fetchOwnProfile: fetchOwnProfileInternal,
  }), [
    user,
    isMiniApp,
    miniAppAdded,
    notificationsEnabled,
    isLoading,
    login,
    logout,
    setUserData,
    getAuthToken,
    addMiniApp,
    handleWebAuth,
    authUrl,
    isAuthPolling,
    cancelAuth,
    showPasskeyModal,
    loginWithPasskey,
    handlePasskeyAuth,
    closePasskeyModal,
    needsOnboarding,
    fetchOwnProfileInternal,
  ]);

  return (
    <AuthContext.Provider value={contextValue}>
      {children}
    </AuthContext.Provider>
  );
};

// eslint-disable-next-line react-refresh/only-export-components
export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
