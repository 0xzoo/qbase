import React, { createContext, useContext, useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { ReactNode } from 'react';
import {
  sdk,
} from '@farcaster/miniapp-sdk';
import { useSignIn, useProfile } from '@farcaster/auth-kit';
import { apiClient } from '../lib/apiClient';
import { BetaAccessModal } from '../components/BetaAccessModal';

// Module-level flags to prevent duplicate fetches across MiniApp re-mounts
// These persist even when the React app re-mounts due to SDK initialization
let miniAppStatusFetchedGlobal = false;

/**
 * Parse a SIWF message's "Issued At:" header. AuthKit can replay a cached
 * sign-in result from minutes ago — we treat anything older than 10 minutes
 * as stale, force a reconnect, and let the next ceremony produce fresh
 * credentials. If the line is missing or unparseable, fall back to "fresh"
 * so a malformed message reaches the server (which will reject it cleanly).
 */
function parseSiwfStaleness(message: string): { stale: boolean; ageMinutes: number } {
  try {
    const issuedAtLine = message.split('\n').find(line => line.startsWith('Issued At:'));
    if (!issuedAtLine) {
      console.warn('[AUTH] No "Issued At:" line in SIWF message — accepting');
      return { stale: false, ageMinutes: 0 };
    }
    const issuedAt = new Date(issuedAtLine.substring('Issued At: '.length).trim());
    const ageMinutes = (Date.now() - issuedAt.getTime()) / (1000 * 60);
    return { stale: ageMinutes > 10, ageMinutes };
  } catch (e) {
    console.error('[AUTH] Failed to parse SIWF timestamp — accepting:', e);
    return { stale: false, ageMinutes: 0 };
  }
}

interface User {
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

interface AuthContextType {
  user: User | null;
  isAuthenticated: boolean;
  isMiniApp: boolean;
  miniAppAdded: boolean;
  notificationsEnabled: boolean;
  isLoading: boolean;
  login: () => void;
  logout: () => void;
  setUserData: (userData: Partial<User>) => void; // Manually set user data
  getAuthToken: () => string | null; // Helper to get auth token for API requests
  addMiniApp: () => Promise<void>; // Prompt user to add miniapp
  handleWebAuth: (res: any) => Promise<void>; // Handle web auth success (from SignInButton)
  // Web auth UI state (for rendering QR modal in components)
  authUrl: string | undefined;
  isAuthPolling: boolean;
  cancelAuth: () => void; // Cancel ongoing auth flow
  // Beta access
  showBetaAccessModal: boolean;
  closeBetaAccessModal: () => void;
  // Passkey auth
  showPasskeyModal: boolean;
  loginWithPasskey: () => void;
  handlePasskeyAuth: (address: string, sessionToken: string, fid?: number | null, displayName?: string, pfpUrl?: string | null) => void;
  closePasskeyModal: () => void;
  // Onboarding
  needsOnboarding: boolean;
  fetchOwnProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  // Try to restore user from localStorage on mount
  const [user, setUser] = useState<User | null>(() => {
    try {
      const saved = localStorage.getItem('fc_user');
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  });
  const [isMiniApp, setIsMiniApp] = useState<boolean>(false);
  const [miniAppAdded, setMiniAppAdded] = useState<boolean>(false);
  const [notificationsEnabled, setNotificationsEnabled] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [authCancelled, setAuthCancelled] = useState(false);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [showBetaAccessModal, setShowBetaAccessModal] = useState(false);
  const [showPasskeyModal, setShowPasskeyModal] = useState(false);
  const [needsOnboarding, setNeedsOnboarding] = useState(false);
  const fetchOwnProfileRef = useRef<((tokenOverride?: string) => Promise<void>) | null>(null);
  const authInitiated = useRef(false);
  const shouldStartPolling = useRef(false);
  // Promise-keyed mutex over per-nonce session exchanges. Replaces the
  // old (sessionExchangeInProgress + processedNonces) pair: same
  // observable behavior, fewer foot-guns, single-source-of-truth.
  // Server-side single-use enforcement on /api/auth/session means a stale
  // nonce that escapes this mutex still fails with 401 — this Map is now
  // about coalescing concurrent in-flight exchanges, not preventing
  // replay (the server does that).
  const sessionExchangeMutex = useRef<Map<string, Promise<void>>>(new Map());
  // Refs filled in after useSignIn returns. Lets exchangeSiwfForSession
  // (declared before useSignIn so the AuthKit onSuccess callback can
  // reference it) reach signOut/connect via stable refs without a
  // bootstrap circular dep.
  const signOutRef = useRef<() => void>(() => {});
  const connectRef = useRef<() => Promise<void>>(async () => {});

  // Register/update user in database after authentication. Defined here
  // so exchangeSiwfForSession (declared just below) can call it without
  // forward-reference issues.
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
      if (response.status === 403) {
        try {
          const errorData = await response.json() as { code?: string; error?: string };
          if (errorData.code === 'BETA_ACCESS_REQUIRED') {
            console.log('[AUTH] Beta access required - showing modal');
            setShowBetaAccessModal(true);
            setUser(null);
            localStorage.removeItem('fc_user');
            return;
          }
        } catch { /* fall through */ }
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

  /**
   * Single source of truth for "I have a SIWF (message, signature, nonce)
   * triple for an FC user — please trade it for a session token". Called
   * from three places: AuthKit's onSuccess, the useProfile-sync effect,
   * and handleWebAuth (PasskeySignInModal's <SignInButton>). Each call
   * site previously inlined ~80 lines of timestamp parsing + nonce
   * dedup + POST + setUser + registerUser + cleanup.
   *
   * Concurrency: a Map<nonce, Promise<void>> coalesces concurrent calls
   * with the same nonce — second caller awaits the first's result rather
   * than racing against it. Server-side single-use enforcement on
   * /api/auth/session means a stale nonce that escapes the mutex (e.g.
   * the entry was already cleared) gets cleanly 401'd by the server, so
   * the client doesn't need its own replay-protection set.
   *
   * Stale-detection: AuthKit can fire onSuccess with a cached SIWF
   * message minutes after sign-in — those produce nonces the server has
   * already deleted (or never issued), and we'd rather force a fresh
   * ceremony than show the user a "Nonce expired" error.
   */
  const exchangeSiwfForSession = useCallback(async (
    creds: { message: string; signature: string; nonce: string },
    user: { fid: number; username: string; pfpUrl?: string; displayName?: string },
  ): Promise<void> => {
    const noncePrefix = creds.nonce.substring(0, 8);

    const { stale, ageMinutes } = parseSiwfStaleness(creds.message);
    if (stale) {
      console.log(`[AUTH] Rejecting stale SIWF (${ageMinutes.toFixed(1)}m old) — forcing fresh sign-in`);
      signOutRef.current();
      setTimeout(() => {
        connectRef.current().then(() => {
          shouldStartPolling.current = true;
        }).catch(err => console.error('[AUTH] Reconnect failed:', err));
      }, 100);
      return;
    }

    // Coalesce concurrent calls for the same nonce.
    const inFlight = sessionExchangeMutex.current.get(creds.nonce);
    if (inFlight) {
      console.log(`[AUTH] Joining in-flight exchange for nonce: ${noncePrefix}…`);
      return inFlight;
    }

    const work = (async () => {
      try {
        console.log(`[AUTH] Exchanging SIWF → session token (nonce: ${noncePrefix}…)`);
        const sessionResponse = await fetch('/api/auth/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(creds),
        });

        if (!sessionResponse.ok) {
          const errorText = await sessionResponse.text();
          console.error(`[AUTH] Session creation failed (${sessionResponse.status}):`, errorText);
          // Fall back to bare user state without sessionToken so the UI
          // doesn't get stuck. The next ceremony fixes things.
          setUser({
            username: user.username,
            fid: user.fid,
            pfpUrl: user.pfpUrl,
            displayName: user.displayName,
          });
          return;
        }

        const sessionData = await sessionResponse.json() as { sessionToken: string; fid: number };
        console.log('[AUTH] ✅ Session created');

        setUser({
          username: user.username,
          fid: user.fid,
          pfpUrl: user.pfpUrl,
          displayName: user.displayName,
          sessionToken: sessionData.sessionToken,
        });

        await registerUser(
          { fid: user.fid, username: user.username, displayName: user.displayName, pfpUrl: user.pfpUrl },
          sessionData.sessionToken,
        );

        fetchOwnProfileRef.current?.(sessionData.sessionToken);
      } finally {
        // Drop the mutex entry shortly after completion so a fresh
        // ceremony with a new nonce can run, but late duplicates of the
        // SAME nonce still see the in-flight promise.
        setTimeout(() => sessionExchangeMutex.current.delete(creds.nonce), 1000);
        signOutRef.current();
      }
    })();

    sessionExchangeMutex.current.set(creds.nonce, work);
    return work;
  }, [registerUser]);

  // Stable nonce callback - prevents hook reinitialization
  const nonceCallback = useCallback(async () => {
    try {
      console.log('[AUTH] 🔄 Nonce callback invoked - fetching from server...');
      const response = await fetch('/api/auth/nonce');
      if (!response.ok) {
        const text = await response.text();
        console.error('[AUTH] Nonce fetch failed:', text);
        throw new Error(`Nonce fetch failed: ${response.status}`);
      }
      const data = await response.json();
      console.log('[AUTH] ✅ Received nonce from server:', data.nonce.substring(0, 8));
      return data.nonce;
    } catch (error) {
      console.error('[AUTH] Nonce fetch error:', error);
      throw error;
    }
  }, []); // Empty deps - this function never changes

  // AuthKit hooks for web
  const authHook = useSignIn({
    nonce: nonceCallback,
    onSuccess: async (res) => {
      console.log('[AUTH] onSuccess triggered with nonce:', res.nonce?.substring(0, 8));

      // Skip the exchange if we already have a session for this same FID —
      // happens on a page reload while AuthKit's last sign-in is still
      // cached. The current sessionToken is the source of truth.
      const cached = localStorage.getItem('fc_user');
      if (cached && res.fid) {
        try {
          const parsed = JSON.parse(cached);
          if (parsed.sessionToken && parsed.fid === res.fid) {
            console.log('[AUTH] Already have valid session for this FID, skipping replay');
            signOut();
            setAuthCancelled(true);
            setIsAuthenticating(false);
            authInitiated.current = false;
            return;
          }
        } catch { /* fall through */ }
      }

      if (res.fid && res.username && res.message && res.signature && res.nonce) {
        await exchangeSiwfForSession(
          { message: res.message, signature: res.signature, nonce: res.nonce },
          { fid: res.fid, username: res.username, pfpUrl: res.pfpUrl, displayName: res.displayName },
        );
      }

      setAuthCancelled(true);
      setIsAuthenticating(false);
      authInitiated.current = false;
    },
    onError: (error) => {
      console.error('[AUTH] Web sign-in error:', error);
      setIsAuthenticating(false);
      authInitiated.current = false;
    },
  });
  
  const {
    signIn,
    signOut,
    connect,
    isConnected,
    url: authUrl,
    isPolling: isAuthPolling,
    isSuccess: isWebAuthenticated,
    data: authData, // This contains message, signature, nonce after success
  } = authHook;
  
  const { profile: webUser } = useProfile();

  // Wire signOut/connect into the refs that exchangeSiwfForSession captured
  // before useSignIn was constructed. signOut and connect are stable across
  // a session, so this effect runs once.
  useEffect(() => {
    signOutRef.current = signOut;
    connectRef.current = connect;
  }, [signOut, connect]);

  // Persist user to localStorage whenever it changes
  useEffect(() => {
    if (user) {
      localStorage.setItem('fc_user', JSON.stringify(user));
    } else {
      localStorage.removeItem('fc_user');
    }
  }, [user]);

  // Hook up apiClient with auth token getter and 401 handler
  useEffect(() => {
    apiClient.setSIWFCredentialsGetter(() => {
      if (user) {
        const tokens = {
          sessionToken: user.sessionToken,
          quickAuthToken: user.quickAuthToken,
        };
        return tokens;
      }
      // Fallback: check localStorage for passkey session token
      // Covers race condition between setUser() and apiClient getter closure
      // update (React async state updates vs synchronous hook fetches)
      const passkeyToken = localStorage.getItem('passkey_session_token');
      if (passkeyToken) {
        return { sessionToken: passkeyToken };
      }
      return null;
    });
  }, [user?.sessionToken, user?.quickAuthToken, user]);

  // Set up 401 handler for automatic logout on session expiry
  useEffect(() => {
    apiClient.setOnUnauthorized(() => {
      console.log('[AUTH] Session expired - logging out automatically');
      
      // Clear user state
      setUser(null);
      
      // Clear localStorage
      localStorage.removeItem('fc_user');
      localStorage.removeItem('passkey_session_token');
      
      // Clear any cached Auth Kit data
      Object.keys(localStorage).forEach(key => {
        if (key.startsWith('fc.') || key.startsWith('@farcaster')) {
          localStorage.removeItem(key);
        }
      });
      
      
      // Reset global fetch flags
      miniAppStatusFetchedGlobal = false;

      // Clear in-flight session-exchange tracking
      sessionExchangeMutex.current.clear();
    });
  }, []);

  const cancelAuth = useCallback(() => {
    // Stop polling and disconnect
    signOut();
    // Reset all flags
    setAuthCancelled(true);
    setIsAuthenticating(false);
    authInitiated.current = false;
    shouldStartPolling.current = false;
  }, [signOut]);
  
  // Expose authUrl only if not cancelled
  const visibleAuthUrl = authCancelled ? undefined : authUrl;

  // Restore session from localStorage on mount
  useEffect(() => {
    if (!isMiniApp && !isLoading) {
      const savedUser = localStorage.getItem('fc_user');
      
      if (savedUser) {
        try {
          const userData = JSON.parse(savedUser);
          
          // Check if session token exists
          if (userData.sessionToken) {
            // User state is already set from initial useState
            // Just verify it's still valid by trying to fetch points
          } else {
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

  useEffect(() => {
    const checkContext = async () => {
      try {
        const isMiniAppEnv = await sdk.isInMiniApp();
        setIsMiniApp(isMiniAppEnv);

        if (isMiniAppEnv) {
          // Check if we have a context with user info
          const context = await sdk.context;
          if (context && context.user) {
            // Get the Quick Auth token for authenticated requests
            try {
              const { token } = await sdk.quickAuth.getToken();
              setUser({
                username: context.user.username,
                fid: context.user.fid,
                pfpUrl: context.user.pfpUrl,
                displayName: context.user.displayName,
                quickAuthToken: token, // Include token for API requests
              });
            } catch (tokenError) {
              console.error("Failed to get Quick Auth token:", tokenError);
              // Set user without token - they'll need to login
              setUser({
                username: context.user.username,
                fid: context.user.fid,
                pfpUrl: context.user.pfpUrl,
                displayName: context.user.displayName,
              });
            }
          }

          sdk.on("miniAppAdded", async ({ notificationDetails: _notificationDetails }) => {
            setMiniAppAdded(true);
            
            // Update KV via API
            try {
              const token = await sdk.quickAuth.getToken();
              await fetch('/api/miniapp/status', {
                method: 'POST',
                headers: { 
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${token.token}`
                },
                body: JSON.stringify({ added: true })
              });
            } catch (error) {
              console.error("Failed to update miniapp status:", error);
            }
          });

          sdk.on("miniAppAddRejected", () => {
            // No action needed
          });

          sdk.on("miniAppRemoved", async () => {
            setMiniAppAdded(false);
            
            // Update KV via API
            try {
              const token = await sdk.quickAuth.getToken();
              await fetch('/api/miniapp/status', {
                method: 'POST',
                headers: { 
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${token.token}`
                },
                body: JSON.stringify({ added: false })
              });
            } catch (error) {
              console.error("Failed to update miniapp status:", error);
            }
          });

          sdk.on("notificationsEnabled", async ({ notificationDetails: _notificationDetails }) => {
            setNotificationsEnabled(true);
            
            // Update KV via API
            try {
              const token = await sdk.quickAuth.getToken();
              await fetch('/api/miniapp/notifications', {
                method: 'POST',
                headers: { 
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${token.token}`
                },
                body: JSON.stringify({ enabled: true })
              });
            } catch (error) {
              console.error("Failed to update notification status:", error);
            }
          });

          sdk.on("notificationsDisabled", async () => {
            setNotificationsEnabled(false);
            
            // Update KV via API
            try {
              const token = await sdk.quickAuth.getToken();
              await fetch('/api/miniapp/notifications', {
                method: 'POST',
                headers: { 
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${token.token}`
                },
                body: JSON.stringify({ enabled: false })
              });
            } catch (error) {
              console.error("Failed to update notification status:", error);
            }
          });

          // Enable back navigation for MiniApp
          // This automatically syncs with browser history (react-router)
          await sdk.back.enableWebNavigation();

          sdk.actions.ready({ disableNativeGestures: true });
        }
      } catch (error) {
        console.error("Error checking MiniApp context:", error);
      } finally {
        setIsLoading(false);
      }
    };

    checkContext();
  }, []);

  // Sync web auth state from useProfile (works with both our custom login and SignInButton)
  useEffect(() => {
    if (!isMiniApp && webUser && webUser.fid && webUser.username) {
      console.log('[AUTH] [useProfile sync] webUser detected:', webUser.fid, webUser.username);

      // If we already have a session for this FID, nothing to do.
      if (!user || !user.sessionToken || user.fid !== webUser.fid) {
        if (authData?.message && authData?.signature && authData?.nonce) {
          // Mutex coalesces this with onSuccess (which AuthKit fires for the
          // same nonce in the same tick) — second call awaits the first.
          exchangeSiwfForSession(
            { message: authData.message, signature: authData.signature, nonce: authData.nonce },
            { fid: webUser.fid, username: webUser.username, pfpUrl: webUser.pfpUrl, displayName: webUser.displayName },
          );
        } else {
          // useProfile saw a user but AuthKit hasn't surfaced the SIWF triple
          // yet (or never will). Set bare profile state so the UI can render.
          setUser({
            username: webUser.username,
            fid: webUser.fid,
            pfpUrl: webUser.pfpUrl,
            displayName: webUser.displayName,
          });
        }
      }

      // Hide auth modal when authenticated and stop polling
      signOut();
      setAuthCancelled(true);
      setIsAuthenticating(false);
      authInitiated.current = false;
    } else if (!isMiniApp && !isWebAuthenticated && !user) {
      // SECURITY WARNING: Mock user for LOCAL DEVELOPMENT ONLY
      // This block MUST NOT execute in production - triple guard enforced
      const isDev = import.meta.env.DEV && !import.meta.env.PROD;
      const isLocalhost = typeof window !== 'undefined' &&
        (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');

      if (isDev && isLocalhost) {
        setUser({
          username: 'zoo',
          fid: 12345,
          pfpUrl: 'https://api.dicebear.com/7.x/avataaars/svg?seed=zoo',
          displayName: 'Zoo',
        });
      }
    }
  }, [isMiniApp, isWebAuthenticated, webUser]);

  // Fetch miniapp added status and notification status when authenticated in miniapp context
  // Consolidated into a single parallel fetch to reduce API calls
  // Uses module-level flag to persist across MiniApp re-mounts
  useEffect(() => {
    if (!isMiniApp || !user?.quickAuthToken) return;
    
    // Prevent duplicate fetches (module-level flag survives re-mounts)
    if (miniAppStatusFetchedGlobal) return;
    miniAppStatusFetchedGlobal = true;

    const fetchMiniAppStatusAndNotifications = async () => {
      try {
        // Fetch both in parallel
        const [statusRes, notifRes] = await Promise.all([
          fetch('/api/miniapp/status', {
            headers: { 'Authorization': `Bearer ${user.quickAuthToken}` }
          }),
          fetch('/api/miniapp/notifications', {
            headers: { 'Authorization': `Bearer ${user.quickAuthToken}` }
          })
        ]);
        
        if (statusRes.ok) {
          const data = await statusRes.json() as { miniAppAdded: boolean };
          setMiniAppAdded(data.miniAppAdded);
        }
        
        if (notifRes.ok) {
          const data = await notifRes.json() as { notificationsEnabled: boolean };
          setNotificationsEnabled(data.notificationsEnabled);
        }
      } catch (error) {
        console.error("Error fetching miniapp status:", error);
      }
    };

    fetchMiniAppStatusAndNotifications();
  }, [isMiniApp, user?.quickAuthToken]);

  const login = useCallback(async () => {
    // Prevent multiple simultaneous auth attempts using ref
    if (authInitiated.current) {
      return;
    }

    // Prevent multiple simultaneous auth attempts
    if (isAuthenticating || isConnected) {
      return;
    }

    // Mark as initiated
    authInitiated.current = true;

    // Reset cancelled state when starting new auth flow
    setAuthCancelled(false);
    setIsAuthenticating(true);

    if (isMiniApp) {
      try {
        // Use Quick Auth for MiniApp authentication
        // This automatically handles token generation and storage
        const { token } = await sdk.quickAuth.getToken();

        // The user info is already in the SDK context
        // We can refresh it if needed
        const context = await sdk.context;
        if (context && context.user) {
          setUser({
            username: context.user.username,
            fid: context.user.fid,
            pfpUrl: context.user.pfpUrl,
            displayName: context.user.displayName,
            quickAuthToken: token, // Store the JWT token
          });

          // Register user in database
          await registerUser({
            fid: context.user.fid,
            username: context.user.username,
            displayName: context.user.displayName,
            pfpUrl: context.user.pfpUrl,
          }, token);
        }
      } catch (e) {
        console.error("MiniApp Quick Auth login failed", e);
      } finally {
        setIsAuthenticating(false);
        authInitiated.current = false;
      }
    } else {
      // Web: Trigger AuthKit sign-in flow
      // Docs: "Call signIn following connect to begin polling for a signature"
      try {
        // Step 1: Connect to relay and create channel
        await connect();

        // Set flag to start polling once connected
        shouldStartPolling.current = true;
      } catch (error) {
        console.error('[AUTH] Auth flow error:', error);
        setIsAuthenticating(false);
        authInitiated.current = false;
      }
    }
  }, [isAuthenticating, isConnected, isMiniApp, connect, registerUser]);

  // Effect: Start polling once connected
  useEffect(() => {
    if (shouldStartPolling.current && isConnected && !isAuthPolling && !isWebAuthenticated) {
      shouldStartPolling.current = false; // Only do this once
      signIn();
    }
  }, [isConnected, isAuthPolling, isWebAuthenticated, signIn]);

  const logout = useCallback(() => {
    if (isMiniApp) {
      // MiniApp logout logic if needed
      setUser(null);
      // Reset global fetch flags
      miniAppStatusFetchedGlobal = false;
    } else {
      // Web: Sign out via AuthKit and clear ALL cached auth data
      signOut();
      setUser(null);
      
      // Clear all auth-related localStorage items
      localStorage.removeItem('fc_user');
      localStorage.removeItem('passkey_session_token');
      localStorage.removeItem('onboarding_complete');

      // Clear stored passkey material (credential IDs + Ed448 private key)
      localStorage.removeItem('qbase-passkeys');
      
      // Clear any cached Auth Kit data (prefixed with 'fc.')
      Object.keys(localStorage).forEach(key => {
        if (key.startsWith('fc.') || key.startsWith('@farcaster')) {
          localStorage.removeItem(key);
        }
      });
      
      
      // Drop any in-flight session exchanges so the next login starts clean
      sessionExchangeMutex.current.clear();
      
      // Reset global fetch flags
      miniAppStatusFetchedGlobal = false;
      
      // Clear onboarding state
      setNeedsOnboarding(false);
      
      console.log('[AUTH] Logged out and cleared all cached auth data');
    }
  }, [isMiniApp, signOut]);

  const setUserData = useCallback((userData: Partial<User>) => {
    setUser(prevUser => ({
      ...prevUser,
      ...userData,
    } as User));
  }, []);

  const addMiniApp = useCallback(async () => {
    if (!isMiniApp) {
      return;
    }

    try {
      // Prompt user to add miniapp
      await sdk.actions.addFrame();
    } catch (error) {
      console.error('Error prompting to add miniapp:', error);
    }
  }, [isMiniApp]);

  const getAuthToken = useCallback((): string | null => {
    if (isMiniApp && user?.quickAuthToken) {
      return user.quickAuthToken;
    }
    // For web auth, return session token
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
      // If we have an explicit token override, bypass apiClient which may have
      // a stale closure over `user` state (React async updates)
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

  // Wire up ref for early callers. Effect (not render) so it runs once per
  // identity change rather than on every render.
  useEffect(() => {
    fetchOwnProfileRef.current = fetchOwnProfileInternal;
  }, [fetchOwnProfileInternal]);

  // Handle web authentication success (from SignInButton)
  const handleWebAuth = useCallback(async (res: any) => {
    if (res.fid && res.username && res.message && res.signature && res.nonce) {
      await exchangeSiwfForSession(
        { message: res.message, signature: res.signature, nonce: res.nonce },
        { fid: res.fid, username: res.username, pfpUrl: res.pfpUrl, displayName: res.displayName },
      );
    }
  }, [exchangeSiwfForSession]);

  const closeBetaAccessModal = useCallback(() => {
    setShowBetaAccessModal(false);
  }, []);

  // Passkey auth handlers
  const loginWithPasskey = useCallback(() => {
    if (isMiniApp) return; // Passkeys only for web/desktop
    setShowPasskeyModal(true);
  }, [isMiniApp]);

  const handlePasskeyAuth = useCallback(async (address: string, sessionToken: string, fid?: number | null, displayName?: string, pfpUrl?: string | null) => {
    const passkeyUser: User = {
      username: displayName || `pk-${address.substring(0, 8)}`,
      fid: fid || undefined,
      displayName: displayName || `Passkey User`,
      pfpUrl: pfpUrl || `https://api.dicebear.com/7.x/identicon/svg?seed=${address}`,
      sessionToken,
      passkeyAddress: address,
    };
    setUser(passkeyUser);
    setShowPasskeyModal(false);
    
    // Fetch stored native profile from backend
    fetchOwnProfileRef.current?.(sessionToken);
    
    console.log(`[AUTH] Passkey login successful: ${address} (FID: ${fid || 'none'})`);
  }, []);

  const closePasskeyModal = useCallback(() => {
    setShowPasskeyModal(false);
  }, []);

  // Check onboarding status whenever user is set (from localStorage restore)
  useEffect(() => {
    if (!user) {
      setNeedsOnboarding(false);
      return;
    }

    // Farcaster users already have identity — no onboarding needed
    if (user.profileSource === 'farcaster' || user.profileSource === 'farcaster-connect') {
      if (typeof window !== 'undefined') {
        localStorage.setItem('onboarding_complete', 'true');
      }
      setNeedsOnboarding(false);
      return;
    }

    // Also: if user has an FID (Farcaster identity), skip onboarding
    if (user.fid && (user.sessionToken || user.quickAuthToken)) {
      if (typeof window !== 'undefined') {
        localStorage.setItem('onboarding_complete', 'true');
      }
      setNeedsOnboarding(false);
      return;
    }

    // If we already fetched from backend, that's authoritative
    if (user.profileSource) {
      if (!user.username) {
        setNeedsOnboarding(true);
      } else {
        setNeedsOnboarding(false);
      }
      return;
    }

    // Otherwise check localStorage flag
    const onboardingComplete = typeof window !== 'undefined' 
      && localStorage.getItem('onboarding_complete') === 'true';
    
    // New users without sessionToken shouldn't trigger onboarding (not authed yet)
    if (!user.sessionToken && !user.quickAuthToken) return;

    if (!user.username && !onboardingComplete) {
      setNeedsOnboarding(true);
    }
  }, [user]);


  // Stabilize the provider value so consumers don't re-render on every
  // AuthProvider render. All handlers are useCallback'd above, so the
  // memo deps just track the state values + handler identities.
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
    authUrl: visibleAuthUrl,
    isAuthPolling,
    cancelAuth,
    showBetaAccessModal,
    closeBetaAccessModal,
    // Passkey auth
    showPasskeyModal,
    loginWithPasskey,
    handlePasskeyAuth,
    closePasskeyModal,
    // Onboarding
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
    visibleAuthUrl,
    isAuthPolling,
    cancelAuth,
    showBetaAccessModal,
    closeBetaAccessModal,
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
      <BetaAccessModal
        isOpen={showBetaAccessModal}
        onClose={closeBetaAccessModal}
      />
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
