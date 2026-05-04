/**
 * useFarcasterMiniAppAuth — encapsulates the Farcaster MiniApp side of
 * AuthContext: detection (`sdk.isInMiniApp()`), Quick Auth token fetch on
 * mount when there's an SDK user context, the four lifecycle SDK event
 * handlers (miniAppAdded/Removed, notifications enabled/disabled) that
 * keep the parent state in sync with what the user does in Warpcast, and
 * the `addMiniApp` action.
 *
 * Kept module-level the way the original AuthContext did: a single
 * `miniAppStatusFetchedGlobal` flag prevents duplicate KV reads across
 * re-mounts that the SDK can trigger when the host webview restarts.
 */
import { useCallback, useEffect, useState } from 'react';
import { sdk } from '@farcaster/miniapp-sdk';
import type { User } from './types';

// Module-level — survives React re-mounts triggered by the SDK
let miniAppStatusFetchedGlobal = false;

interface MiniAppAuthDeps {
  setUser: (user: User) => void;
  setIsLoading: (loading: boolean) => void;
  /** Read at runtime so the status-fetch effect can re-arm when the user logs in. */
  user: User | null;
}

export interface FarcasterMiniAppAuthHook {
  isMiniApp: boolean;
  miniAppAdded: boolean;
  notificationsEnabled: boolean;
  addMiniApp: () => Promise<void>;
}

/** Reset the module-level flag — used by logout / 401 paths. */
export function resetMiniAppStatusFetched(): void {
  miniAppStatusFetchedGlobal = false;
}

export function useFarcasterMiniAppAuth(deps: MiniAppAuthDeps): FarcasterMiniAppAuthHook {
  const { setUser, setIsLoading, user } = deps;
  const [isMiniApp, setIsMiniApp] = useState(false);
  const [miniAppAdded, setMiniAppAdded] = useState(false);
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);

  // Detection + initial Quick Auth + lifecycle event subscriptions.
  // Empty-deps so this runs exactly once per AuthProvider mount.
  useEffect(() => {
    const checkContext = async () => {
      try {
        const isMiniAppEnv = await sdk.isInMiniApp();
        setIsMiniApp(isMiniAppEnv);

        if (isMiniAppEnv) {
          const context = await sdk.context;
          if (context && context.user) {
            try {
              const { token } = await sdk.quickAuth.getToken();
              setUser({
                username: context.user.username,
                fid: context.user.fid,
                pfpUrl: context.user.pfpUrl,
                displayName: context.user.displayName,
                quickAuthToken: token,
              });
            } catch (tokenError) {
              console.error('Failed to get Quick Auth token:', tokenError);
              setUser({
                username: context.user.username,
                fid: context.user.fid,
                pfpUrl: context.user.pfpUrl,
                displayName: context.user.displayName,
              });
            }
          }

          sdk.on('miniAppAdded', async () => {
            setMiniAppAdded(true);
            try {
              const t = await sdk.quickAuth.getToken();
              await fetch('/api/miniapp/status', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${t.token}`,
                },
                body: JSON.stringify({ added: true }),
              });
            } catch (error) {
              console.error('Failed to update miniapp status:', error);
            }
          });

          sdk.on('miniAppAddRejected', () => {
            // No action needed
          });

          sdk.on('miniAppRemoved', async () => {
            setMiniAppAdded(false);
            try {
              const t = await sdk.quickAuth.getToken();
              await fetch('/api/miniapp/status', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${t.token}`,
                },
                body: JSON.stringify({ added: false }),
              });
            } catch (error) {
              console.error('Failed to update miniapp status:', error);
            }
          });

          sdk.on('notificationsEnabled', async () => {
            setNotificationsEnabled(true);
            try {
              const t = await sdk.quickAuth.getToken();
              await fetch('/api/miniapp/notifications', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${t.token}`,
                },
                body: JSON.stringify({ enabled: true }),
              });
            } catch (error) {
              console.error('Failed to update notification status:', error);
            }
          });

          sdk.on('notificationsDisabled', async () => {
            setNotificationsEnabled(false);
            try {
              const t = await sdk.quickAuth.getToken();
              await fetch('/api/miniapp/notifications', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${t.token}`,
                },
                body: JSON.stringify({ enabled: false }),
              });
            } catch (error) {
              console.error('Failed to update notification status:', error);
            }
          });

          await sdk.back.enableWebNavigation();
          sdk.actions.ready({ disableNativeGestures: true });
        }
      } catch (error) {
        console.error('Error checking MiniApp context:', error);
      } finally {
        setIsLoading(false);
      }
    };

    checkContext();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetch persisted miniapp/notification status from KV once we have a JWT.
  // Module-level dedup flag survives MiniApp re-mounts.
  useEffect(() => {
    if (!isMiniApp || !user?.quickAuthToken) return;
    if (miniAppStatusFetchedGlobal) return;
    miniAppStatusFetchedGlobal = true;

    (async () => {
      try {
        const [statusRes, notifRes] = await Promise.all([
          fetch('/api/miniapp/status', {
            headers: { 'Authorization': `Bearer ${user.quickAuthToken}` },
          }),
          fetch('/api/miniapp/notifications', {
            headers: { 'Authorization': `Bearer ${user.quickAuthToken}` },
          }),
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
        console.error('Error fetching miniapp status:', error);
      }
    })();
  }, [isMiniApp, user?.quickAuthToken]);

  const addMiniApp = useCallback(async () => {
    if (!isMiniApp) return;
    try {
      await sdk.actions.addFrame();
    } catch (error) {
      console.error('Error prompting to add miniapp:', error);
    }
  }, [isMiniApp]);

  return { isMiniApp, miniAppAdded, notificationsEnabled, addMiniApp };
}
