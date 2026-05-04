/**
 * useFarcasterWebAuth — encapsulates the AuthKit-driven SIWF flow used
 * outside MiniApp environments (browser tab, desktop, etc.). Owns the
 * relay connection, QR/auth-url state, polling, the SIWF→session
 * exchange (including the per-nonce coalesce mutex and stale-message
 * rejection), and the AuthKit-cache cleanup that runs on logout.
 *
 * The orchestrator's `login`/`logout` dispatch on `isMiniApp` and
 * delegate the web branch here. The hook surfaces:
 *   - `login` / `logout`        — web-only entry points
 *   - `cancelAuth`              — abort an in-flight QR ceremony
 *   - `handleWebAuth`           — accept a `<SignInButton>` callback
 *   - `authUrl` / `isAuthPolling` / `isWebAuthenticated`
 *   - `isAuthenticating`        — true once `login` starts until the
 *                                 ceremony resolves or is cancelled
 *   - `clearSessionExchangeMutex` — for the orchestrator's 401 handler
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSignIn, useProfile } from '@farcaster/auth-kit';
import type { User } from './types';

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

interface RegisterUserInput {
  fid: number;
  username: string;
  displayName?: string;
  pfpUrl?: string;
}

interface FarcasterWebAuthDeps {
  isMiniApp: boolean;
  /** Read by the useProfile-sync effect to detect FID transitions. */
  user: User | null;
  setUser: React.Dispatch<React.SetStateAction<User | null>>;
  registerUser: (data: RegisterUserInput, token?: string) => Promise<unknown>;
  /** Optional — invoked with the fresh session token after a successful exchange. */
  fetchOwnProfile?: (token: string) => Promise<void> | void;
}

export interface FarcasterWebAuthHook {
  login: () => Promise<void>;
  logout: () => void;
  cancelAuth: () => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handleWebAuth: (res: any) => Promise<void>;
  authUrl: string | undefined;
  isAuthPolling: boolean;
  isWebAuthenticated: boolean;
  isAuthenticating: boolean;
  /** Drop any in-flight per-nonce exchanges. Used by the orchestrator's 401 handler. */
  clearSessionExchangeMutex: () => void;
}

export function useFarcasterWebAuth(deps: FarcasterWebAuthDeps): FarcasterWebAuthHook {
  const { isMiniApp, user, setUser, registerUser, fetchOwnProfile } = deps;

  const [authCancelled, setAuthCancelled] = useState(false);
  const [isAuthenticating, setIsAuthenticating] = useState(false);

  // Promise-keyed mutex over per-nonce session exchanges. Replaces the
  // old (sessionExchangeInProgress + processedNonces) pair. Server-side
  // single-use enforcement on /api/auth/session means a stale nonce
  // that escapes the mutex still fails with 401 — this Map is now
  // about coalescing concurrent in-flight exchanges, not preventing
  // replay (the server does that).
  const sessionExchangeMutex = useRef<Map<string, Promise<void>>>(new Map());

  // Refs filled in after useSignIn returns. Lets exchangeSiwfForSession
  // (declared before useSignIn so the AuthKit onSuccess callback can
  // reference it) reach signOut/connect via stable refs without a
  // bootstrap circular dep.
  const signOutRef = useRef<() => void>(() => {});
  const connectRef = useRef<() => Promise<void>>(async () => {});

  const authInitiated = useRef(false);
  const shouldStartPolling = useRef(false);

  /**
   * Single source of truth for "I have a SIWF (message, signature, nonce)
   * triple for an FC user — please trade it for a session token". Called
   * from three places: AuthKit's onSuccess, the useProfile-sync effect,
   * and handleWebAuth (PasskeySignInModal's <SignInButton>).
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
    profile: { fid: number; username: string; pfpUrl?: string; displayName?: string },
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
            username: profile.username,
            fid: profile.fid,
            pfpUrl: profile.pfpUrl,
            displayName: profile.displayName,
          });
          return;
        }

        const sessionData = await sessionResponse.json() as { sessionToken: string; fid: number };
        console.log('[AUTH] ✅ Session created');

        setUser({
          username: profile.username,
          fid: profile.fid,
          pfpUrl: profile.pfpUrl,
          displayName: profile.displayName,
          sessionToken: sessionData.sessionToken,
        });

        await registerUser(
          { fid: profile.fid, username: profile.username, displayName: profile.displayName, pfpUrl: profile.pfpUrl },
          sessionData.sessionToken,
        );

        await fetchOwnProfile?.(sessionData.sessionToken);
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
  }, [setUser, registerUser, fetchOwnProfile]);

  // Stable nonce callback — empty deps so AuthKit doesn't reinitialize.
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
  }, []);

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
            authHook.signOut();
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
    data: authData,
  } = authHook;

  const { profile: webUser } = useProfile();

  // Wire signOut/connect into the refs that exchangeSiwfForSession captured
  // before useSignIn was constructed. signOut/connect are stable across
  // a session, so this effect runs once.
  useEffect(() => {
    signOutRef.current = signOut;
    connectRef.current = connect;
  }, [signOut, connect]);

  // Sync web auth state from useProfile — covers both our custom login
  // and SignInButton (which may surface a webUser that AuthKit's onSuccess
  // hasn't fired for yet).
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMiniApp, isWebAuthenticated, webUser]);

  // Start polling once connected (paired with `shouldStartPolling.current`
  // set by login() after connect() resolves).
  useEffect(() => {
    if (shouldStartPolling.current && isConnected && !isAuthPolling && !isWebAuthenticated) {
      shouldStartPolling.current = false;
      signIn();
    }
  }, [isConnected, isAuthPolling, isWebAuthenticated, signIn]);

  const login = useCallback(async () => {
    if (authInitiated.current) return;
    if (isAuthenticating || isConnected) return;

    authInitiated.current = true;
    setAuthCancelled(false);
    setIsAuthenticating(true);

    try {
      // Step 1: Connect to relay and create channel.
      // Step 2: useEffect above fires signIn() once isConnected flips.
      await connect();
      shouldStartPolling.current = true;
    } catch (error) {
      console.error('[AUTH] Auth flow error:', error);
      setIsAuthenticating(false);
      authInitiated.current = false;
    }
  }, [isAuthenticating, isConnected, connect]);

  const logout = useCallback(() => {
    signOut();
    // Clear cached AuthKit data
    Object.keys(localStorage).forEach(key => {
      if (key.startsWith('fc.') || key.startsWith('@farcaster')) {
        localStorage.removeItem(key);
      }
    });
    sessionExchangeMutex.current.clear();
  }, [signOut]);

  const cancelAuth = useCallback(() => {
    signOut();
    setAuthCancelled(true);
    setIsAuthenticating(false);
    authInitiated.current = false;
    shouldStartPolling.current = false;
  }, [signOut]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleWebAuth = useCallback(async (res: any) => {
    if (res.fid && res.username && res.message && res.signature && res.nonce) {
      await exchangeSiwfForSession(
        { message: res.message, signature: res.signature, nonce: res.nonce },
        { fid: res.fid, username: res.username, pfpUrl: res.pfpUrl, displayName: res.displayName },
      );
    }
  }, [exchangeSiwfForSession]);

  const clearSessionExchangeMutex = useCallback(() => {
    sessionExchangeMutex.current.clear();
  }, []);

  const visibleAuthUrl = authCancelled ? undefined : authUrl;

  return {
    login,
    logout,
    cancelAuth,
    handleWebAuth,
    authUrl: visibleAuthUrl,
    isAuthPolling,
    isWebAuthenticated,
    isAuthenticating,
    clearSessionExchangeMutex,
  };
}
