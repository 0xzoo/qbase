import React, { createContext, useContext, useState, useEffect } from 'react';
import type { ReactNode } from 'react';
import {
  sdk,
} from '@farcaster/miniapp-sdk';
import { useSignIn, useProfile } from '@farcaster/auth-kit';
import type { NeynarSigner } from '../lib/types';

interface User {
  username?: string;
  fid?: number;
  pfpUrl?: string;
  displayName?: string;
  quickAuthToken?: string; // JWT token from Quick Auth for MiniApp
  signers?: NeynarSigner[]; // Neynar-managed signers for Farcaster actions
  message?: string; // SIWF message
  signature?: string; // SIWF signature
  nonce?: string; // Authentication nonce
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
  getAuthToken: () => string | null; // Helper to get auth token for API requests
  addMiniApp: () => Promise<void>; // Prompt user to add miniapp
  // Signer management
  signers: NeynarSigner[] | null;
  hasSigner: boolean;
  createSigner: () => Promise<void>;
  refreshSigners: () => Promise<void>;
  activeSigner: NeynarSigner | null;
  // Web auth UI state (for rendering QR modal in components)
  authUrl: string | undefined;
  isAuthPolling: boolean;
  cancelAuth: () => void; // Cancel ongoing auth flow
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [isMiniApp, setIsMiniApp] = useState<boolean>(false);
  const [miniAppAdded, setMiniAppAdded] = useState<boolean>(false);
  const [notificationsEnabled, setNotificationsEnabled] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [signers, setSigners] = useState<NeynarSigner[] | null>(null);
  const [pendingSignerUuid, setPendingSignerUuid] = useState<string | null>(null);

  // AuthKit hooks for web
  const authHook = useSignIn({
    nonce: async () => {
      try {
        console.log('[AUTH] Fetching nonce from backend...');
        const response = await fetch('/api/auth/nonce');
        if (!response.ok) {
          throw new Error(`Nonce fetch failed: ${response.status}`);
        }
        const data = await response.json();
        console.log('[AUTH] Nonce received:', data.nonce.substring(0, 8) + '...');
        return data.nonce;
      } catch (error) {
        console.error('[AUTH] Nonce fetch error:', error);
        throw error;
      }
    },
    onSuccess: (res) => {
      console.log('[AUTH] Web sign-in successful:', res);
    },
    onError: (error) => {
      console.error('[AUTH] Web sign-in error:', error);
    },
  });
  
  const {
    signIn,
    signOut,
    connect,
    reconnect,
    url: authUrl,
    isPolling: isAuthPolling,
    isSuccess: isWebAuthenticated,
    isError: authError,
    error: authErrorDetails,
  } = authHook;
  
  const { profile: webUser } = useProfile();

  // Cancel auth flow - we'll use a local state to hide the modal
  const [authCancelled, setAuthCancelled] = useState(false);
  
  const cancelAuth = () => {
    console.log('[AUTH] Cancelling auth flow');
    setAuthCancelled(true);
    // Reset after a short delay to allow modal to close
    setTimeout(() => setAuthCancelled(false), 100);
  };
  
  // Expose authUrl only if not cancelled
  const visibleAuthUrl = authCancelled ? undefined : authUrl;

  // Debug: Log when hook initializes
  useEffect(() => {
    console.log('[AUTH] useSignIn hook initialized');
    console.log('[AUTH] connect available:', typeof connect);
  }, []);

  // Log auth state changes
  useEffect(() => {
    if (authUrl) {
      console.log('[AUTH] Auth URL available:', authUrl.substring(0, 50) + '...');
    }
    if (isAuthPolling) {
      console.log('[AUTH] Polling started');
    }
    if (authError) {
      console.error('[AUTH] Auth error:', authErrorDetails);
    }
  }, [authUrl, isAuthPolling, authError, authErrorDetails]);

  useEffect(() => {
    const checkContext = async () => {
      try {
        const isMiniAppEnv = await sdk.isInMiniApp();
        setIsMiniApp(isMiniAppEnv);

        if (isMiniAppEnv) {
          // Check if we have a context with user info
          const context = await sdk.context;
          if (context && context.user) {
            setUser({
              username: context.user.username,
              fid: context.user.fid,
              pfpUrl: context.user.pfpUrl,
              displayName: context.user.displayName,
            });
          }

          sdk.on("miniAppAdded", async ({ notificationDetails }) => {
            console.log("MiniApp added:", notificationDetails);
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
            console.log("MiniApp add rejected");
          });

          sdk.on("miniAppRemoved", async () => {
            console.log("MiniApp removed");
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

          sdk.on("notificationsEnabled", async ({ notificationDetails }) => {
            console.log("Notifications enabled:", notificationDetails);
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
            console.log("Notifications disabled");
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

  // Sync web auth state
  useEffect(() => {
    if (!isMiniApp && isWebAuthenticated && webUser) {
      setUser({
        username: webUser.username,
        fid: webUser.fid,
        pfpUrl: webUser.pfpUrl,
        displayName: webUser.displayName,
      });
    } else if (!isMiniApp && !isWebAuthenticated) {
      // SECURITY WARNING: Mock user for LOCAL DEVELOPMENT ONLY
      // This block MUST NOT execute in production - triple guard enforced
      const isDev = import.meta.env.DEV && !import.meta.env.PROD;
      const isLocalhost = typeof window !== 'undefined' &&
        (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');

      if (isDev && isLocalhost) {
        console.warn('[AUTH] Using mock user - DEVELOPMENT MODE ONLY');
        setUser({
          username: 'zoo',
          fid: 12345,
          pfpUrl: 'https://api.dicebear.com/7.x/avataaars/svg?seed=zoo',
          displayName: 'Zoo',
        });
      } else {
        setUser(null);
      }
    }
  }, [isMiniApp, isWebAuthenticated, webUser]);

  // Fetch miniapp added status and notification status when authenticated in miniapp context
  useEffect(() => {
    if (!isMiniApp || !user?.quickAuthToken) return;

    const fetchMiniAppStatus = async () => {
      try {
        const response = await fetch('/api/miniapp/status', {
          headers: {
            'Authorization': `Bearer ${user.quickAuthToken}`
          }
        });
        
        if (response.ok) {
          const data = await response.json() as { miniAppAdded: boolean };
          setMiniAppAdded(data.miniAppAdded);
        }
      } catch (error) {
        console.error("Error fetching miniapp status:", error);
      }
    };

    const fetchNotificationStatus = async () => {
      try {
        const response = await fetch('/api/miniapp/notifications', {
          headers: {
            'Authorization': `Bearer ${user.quickAuthToken}`
          }
        });
        
        if (response.ok) {
          const data = await response.json() as { notificationsEnabled: boolean };
          setNotificationsEnabled(data.notificationsEnabled);
        }
      } catch (error) {
        console.error("Error fetching notification status:", error);
      }
    };

    fetchMiniAppStatus();
    fetchNotificationStatus();
  }, [isMiniApp, user?.quickAuthToken]);

  const login = async () => {
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
        }
      } catch (e) {
        console.error("MiniApp Quick Auth login failed", e);
      }
    } else {
      // Web: Trigger AuthKit sign-in flow using connect()
      console.log('[AUTH] Starting web sign-in with connect()...');
      
      try {
        await connect();
        console.log('[AUTH] connect() completed');
      } catch (error) {
        console.error('[AUTH] Error calling connect():', error);
      }
    }
  };

  const logout = () => {
    if (isMiniApp) {
      // MiniApp logout logic if needed
      setUser(null);
    } else {
      // Web: Sign out via AuthKit
      signOut();
      setUser(null);
    }
  };

  const addMiniApp = async () => {
    if (!isMiniApp) {
      console.warn('addMiniApp called outside MiniApp context');
      return;
    }

    try {
      // Prompt user to add miniapp
      await sdk.actions.addFrame();
    } catch (error) {
      console.error('Error prompting to add miniapp:', error);
    }
  };

  const getAuthToken = (): string | null => {
    if (isMiniApp && user?.quickAuthToken) {
      return user.quickAuthToken;
    }
    // For web auth, we might need a different approach
    // AuthKit doesn't provide a direct token
    return null;
  };

  // Signer management functions
  const createSigner = async () => {
    try {
      // Create signer via worker endpoint
      const response = await fetch('/api/auth/signer', {
        method: 'POST',
      });

      if (!response.ok) {
        throw new Error('Failed to create signer');
      }

      const signer = await response.json() as NeynarSigner;
      setPendingSignerUuid(signer.signer_uuid);

      // Register the signed key
      await registerSignedKey(signer.signer_uuid, signer.public_key);
    } catch (error) {
      console.error('Error creating signer:', error);
      throw error;
    }
  };

  const registerSignedKey = async (signerUuid: string, publicKey: string) => {
    try {
      const response = await fetch('/api/auth/signer/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signerUuid, publicKey }),
      });

      if (!response.ok) {
        throw new Error('Failed to register signed key');
      }

      const result = await response.json();
      return result;
    } catch (error) {
      console.error('Error registering signed key:', error);
      throw error;
    }
  };

  const refreshSigners = async () => {
    if (!user?.message || !user?.signature) {
      console.warn('Cannot refresh signers: missing SIWF message or signature');
      return;
    }

    try {
      const response = await fetch(
        `/api/auth/signers?message=${encodeURIComponent(user.message)}&signature=${user.signature}`
      );

      if (!response.ok) {
        throw new Error('Failed to fetch signers');
      }

      const data = await response.json() as { signers: NeynarSigner[] };
      setSigners(data.signers || []);
      
      // Update user with signers
      setUser(prev => prev ? { ...prev, signers: data.signers || [] } : null);
    } catch (error) {
      console.error('Error refreshing signers:', error);
    }
  };

  /**
   * Optimized polling for signer approval with exponential backoff
   * Reduces API calls from ~150 to ~70 per approval (53% reduction)
   */
  useEffect(() => {
    if (!pendingSignerUuid) return;

    let attempts = 0;
    const MAX_ATTEMPTS = 75;
    let pollInterval: NodeJS.Timeout;
    let timeoutId: NodeJS.Timeout;

    const getPollingInterval = (attempt: number): number => {
      if (attempt <= 40) return 2000;   // 0-80s: 2s interval
      if (attempt <= 52) return 5000;   // 80-140s: 5s interval
      return 10000;                     // 140-320s: 10s interval
    };

    const pollSigner = async () => {
      attempts++;

      if (attempts > MAX_ATTEMPTS) {
        cleanup();
        console.log('⏱️ Signer polling timed out');
        setPendingSignerUuid(null);
        return;
      }

      try {
        const response = await fetch(`/api/auth/signer?signerUuid=${pendingSignerUuid}`);
        
        if (!response.ok) return;

        const signer = await response.json() as NeynarSigner;

        if (signer.status === 'approved') {
          cleanup();
          console.log(`✅ Signer approved after ${attempts} attempts`);
          setPendingSignerUuid(null);
          await refreshSigners();
        } else {
          // Adjust interval if needed
          const newInterval = getPollingInterval(attempts);
          const currentInterval = getPollingInterval(attempts - 1);
          if (newInterval !== currentInterval) {
            reschedule(newInterval);
          }
        }
      } catch (error) {
        console.error('Error polling signer:', error);
      }
    };

    const reschedule = (interval: number) => {
      if (pollInterval) clearInterval(pollInterval);
      pollInterval = setInterval(pollSigner, interval);
    };

    const cleanup = () => {
      if (pollInterval) clearInterval(pollInterval);
      if (timeoutId) clearTimeout(timeoutId);
    };

    // Start polling with initial 1s interval
    pollInterval = setInterval(pollSigner, 1000);

    // Safety timeout after 5 minutes
    timeoutId = setTimeout(() => {
      cleanup();
      console.log('⏱️ Signer polling safety timeout reached');
      setPendingSignerUuid(null);
    }, 300000);

    return cleanup;
  }, [pendingSignerUuid]);

  // Computed values
  const hasSigner = signers ? signers.some(s => s.status === 'approved') : false;
  const activeSigner = signers ? signers.find(s => s.status === 'approved') || null : null;

  return (
    <AuthContext.Provider
      value={{
        user,
        isAuthenticated: !!user,
        isMiniApp,
        miniAppAdded,
        notificationsEnabled,
        isLoading,
        login,
        logout,
        getAuthToken,
        addMiniApp,
        signers,
        hasSigner,
        createSigner,
        refreshSigners,
        activeSigner,
        authUrl: visibleAuthUrl,
        isAuthPolling,
        cancelAuth,
      }}
    >
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
