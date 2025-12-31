import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import type { ReactNode } from 'react';
import {
  sdk,
} from '@farcaster/miniapp-sdk';
import { useSignIn, useProfile } from '@farcaster/auth-kit';
import type { NeynarSigner } from '../lib/types';
import { apiClient } from '../lib/apiClient';

interface User {
  username?: string;
  fid?: number;
  pfpUrl?: string;
  displayName?: string;
  quickAuthToken?: string; // JWT token from Quick Auth for MiniApp
  sessionToken?: string; // Session token from SIWF exchange (Web)
  signers?: NeynarSigner[]; // Neynar-managed signers for Farcaster actions
  message?: string; // SIWF message (temporary, for initial auth)
  signature?: string; // SIWF signature (temporary, for initial auth)
  nonce?: string; // Authentication nonce (temporary, for initial auth)
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
  const [signers, setSigners] = useState<NeynarSigner[] | null>(null);
  const [pendingSignerUuid, setPendingSignerUuid] = useState<string | null>(null);
  const [authCancelled, setAuthCancelled] = useState(false);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const authInitiated = useRef(false);
  const shouldStartPolling = useRef(false);
  const sessionExchangeInProgress = useRef<string | null>(null); // Track nonce being exchanged

  // Stable nonce callback - prevents hook reinitialization
  const nonceCallback = useCallback(async () => {
    try {
      const response = await fetch('/api/auth/nonce');
      if (!response.ok) {
        const text = await response.text();
        console.error('[AUTH] Nonce fetch failed:', text);
        throw new Error(`Nonce fetch failed: ${response.status}`);
      }
      const data = await response.json();
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
      if (res.fid && res.username && res.message && res.signature && res.nonce) {
        // Prevent duplicate session exchange with same nonce
        // MUST check and set atomically to prevent race condition
        if (sessionExchangeInProgress.current === res.nonce) {
          return;
        }
        
        // Mark this nonce as being processed IMMEDIATELY (before async operations)
        sessionExchangeInProgress.current = res.nonce;
        
        try {
          // Exchange SIWF credentials for a session token
          const sessionResponse = await fetch('/api/auth/session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              message: res.message,
              signature: res.signature,
              nonce: res.nonce,
            }),
          });

          if (!sessionResponse.ok) {
            const errorText = await sessionResponse.text();
            console.error('[AUTH] Session creation failed:', errorText);
            throw new Error(`Failed to create session: ${sessionResponse.status}`);
          }

          const sessionData = await sessionResponse.json() as { sessionToken: string; fid: number };

          // Update user state with session token
          const newUser = {
            username: res.username,
            fid: res.fid,
            pfpUrl: res.pfpUrl,
            displayName: res.displayName,
            sessionToken: sessionData.sessionToken,
          };
          setUser(newUser);

          // Register user in database
          await registerUser({
            fid: res.fid,
            username: res.username,
            displayName: res.displayName,
            pfpUrl: res.pfpUrl,
          }, sessionData.sessionToken);

        } catch (error) {
          console.error('[AUTH] Failed to create session:', error);
          // Fall back to storing SIWF credentials (single-use)
          setUser({
            username: res.username,
            fid: res.fid,
            pfpUrl: res.pfpUrl,
            displayName: res.displayName,
            message: res.message,
            signature: res.signature,
            nonce: res.nonce,
          });
        } finally {
          // Clear the in-progress marker after a delay
          setTimeout(() => {
            if (sessionExchangeInProgress.current === res.nonce) {
              sessionExchangeInProgress.current = null;
            }
          }, 1000);
        }
      }
      
      // Stop polling and clean up AuthKit state
      signOut();
      
      // Hide the auth modal and reset authenticating flag
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
    reconnect,
    isConnected,
    url: authUrl,
    isPolling: isAuthPolling,
    isSuccess: isWebAuthenticated,
    isError: authError,
    error: authErrorDetails,
    channelToken,
    data: authData, // This contains message, signature, nonce after success
  } = authHook;
  
  const { profile: webUser } = useProfile();

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
        const tokens = {
          sessionToken: user.sessionToken,
          quickAuthToken: user.quickAuthToken,
        };
        return tokens;
      }
      return null;
    });
  }, [user?.sessionToken, user?.quickAuthToken, user]);

  const cancelAuth = () => {
    // Stop polling and disconnect
    signOut();
    // Reset all flags
    setAuthCancelled(true);
    setIsAuthenticating(false);
    authInitiated.current = false;
    shouldStartPolling.current = false;
  };
  
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
            setUser({
              username: context.user.username,
              fid: context.user.fid,
              pfpUrl: context.user.pfpUrl,
              displayName: context.user.displayName,
            });
          }

          sdk.on("miniAppAdded", async ({ notificationDetails }) => {
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

          sdk.on("notificationsEnabled", async ({ notificationDetails }) => {
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
      // If user doesn't exist or doesn't have a session token, we need to create one
      if (!user || !user.sessionToken || user.fid !== webUser.fid) {
        // Check if we have SIWF data from the authHook
        if (authData?.message && authData?.signature && authData?.nonce) {
          // Prevent duplicate session exchange - check if already in progress
          // MUST check and set atomically to prevent race condition
          if (sessionExchangeInProgress.current === authData.nonce) {
            return;
          }
          
          // Mark this nonce as being processed IMMEDIATELY (before async operations)
          sessionExchangeInProgress.current = authData.nonce;
          
          // Exchange for session token
          (async () => {
            try {
              const sessionResponse = await fetch('/api/auth/session', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  message: authData.message,
                  signature: authData.signature,
                  nonce: authData.nonce,
                }),
              });

              if (sessionResponse.ok) {
                const sessionData = await sessionResponse.json() as { sessionToken: string; fid: number };

                setUser({
                  username: webUser.username,
                  fid: webUser.fid,
                  pfpUrl: webUser.pfpUrl,
                  displayName: webUser.displayName,
                  sessionToken: sessionData.sessionToken,
                });

                // Register user
                await registerUser({
                  fid: webUser.fid,
                  username: webUser.username,
                  displayName: webUser.displayName,
                  pfpUrl: webUser.pfpUrl,
                }, sessionData.sessionToken);
              } else {
                const errorText = await sessionResponse.text();
                console.error('[AUTH] Session creation failed:', errorText);
              }
            } catch (error) {
              console.error('[AUTH] Failed to exchange for session in sync:', error);
            } finally {
              // Clear the in-progress marker after a delay
              setTimeout(() => {
                if (sessionExchangeInProgress.current === authData.nonce) {
                  sessionExchangeInProgress.current = null;
                }
              }, 1000);
              
              // Stop polling and clean up AuthKit state
              signOut();
            }
          })();
        } else {
          // No SIWF data available, just set user data
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

  // Load signers when user is authenticated
  useEffect(() => {
    if (user?.fid && !signers) {
      refreshSigners();
    }
  }, [user?.fid]); // Only depends on fid, not the whole user object

  const login = async () => {
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
  };

  // Effect: Start polling once connected
  useEffect(() => {
    if (shouldStartPolling.current && isConnected && !isAuthPolling && !isWebAuthenticated) {
      shouldStartPolling.current = false; // Only do this once
      signIn();
    }
  }, [isConnected, isAuthPolling, isWebAuthenticated, signIn]);

  const logout = () => {
    if (isMiniApp) {
      // MiniApp logout logic if needed
      setUser(null);
    } else {
      // Web: Sign out via AuthKit and clear localStorage
      signOut();
      setUser(null);
      localStorage.removeItem('fc_user');
    }
  };

  const setUserData = (userData: Partial<User>) => {
    setUser(prevUser => ({
      ...prevUser,
      ...userData,
    } as User));
  };

  const addMiniApp = async () => {
    if (!isMiniApp) {
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
    // For web auth, return session token
    if (user?.sessionToken) {
      return user.sessionToken;
    }
    return null;
  };

  // Handle web authentication success (from SignInButton)
  const handleWebAuth = async (res: any) => {
    if (res.fid && res.username && res.message && res.signature && res.nonce) {
      // Prevent duplicate session exchange with same nonce
      // MUST check and set atomically to prevent race condition
      if (sessionExchangeInProgress.current === res.nonce) {
        return;
      }
      
      // Mark this nonce as being processed IMMEDIATELY (before async operations)
      sessionExchangeInProgress.current = res.nonce;

      try {
        // Exchange SIWF credentials for session token
        const sessionResponse = await fetch('/api/auth/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: res.message,
            signature: res.signature,
            nonce: res.nonce,
          }),
        });

        if (!sessionResponse.ok) {
          const errorText = await sessionResponse.text();
          console.error('[AUTH] Session creation failed:', errorText);
          throw new Error(`Failed to create session: ${sessionResponse.status}`);
        }

        const sessionData = await sessionResponse.json() as { sessionToken: string; fid: number };

        // Update user state with session token
        const newUser = {
          username: res.username,
          fid: res.fid,
          pfpUrl: res.pfpUrl,
          displayName: res.displayName,
          sessionToken: sessionData.sessionToken,
        };
        setUser(newUser);

        // Register user in database
        await registerUser({
          fid: res.fid,
          username: res.username,
          displayName: res.displayName,
          pfpUrl: res.pfpUrl,
        }, sessionData.sessionToken);

      } catch (error) {
        console.error('[AUTH] Failed to handle web auth:', error);
        // Fall back to setting user without session token
        setUser({
          username: res.username,
          fid: res.fid,
          pfpUrl: res.pfpUrl,
          displayName: res.displayName,
        });
      } finally {
        // Clear the in-progress marker after a delay to prevent immediate re-attempts
        setTimeout(() => {
          if (sessionExchangeInProgress.current === res.nonce) {
            sessionExchangeInProgress.current = null;
          }
        }, 1000);
      }
      
      // Stop polling and clean up AuthKit state after successful auth
      signOut();
    }
  };

  // Register/update user in database after authentication
  const registerUser = async (
    userData: { fid: number; username: string; displayName?: string; pfpUrl?: string }, 
    token?: string // JWT (MiniApp) or session token (Web)
  ) => {
    try {
      const headers: HeadersInit = {
        'Content-Type': 'application/json',
      };
      
      // Add auth token (JWT or session)
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
      
      const requestBody = {
        fid: userData.fid,
        fname: userData.username,
        displayName: userData.displayName,
        pfpUrl: userData.pfpUrl,
      };
      
      const response = await fetch('/api/users', {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
      });

      if (response.ok) {
        const result = await response.json();
        return result.user;
      } else {
        const error = await response.text();
        console.error('[AUTH] Failed to register user:', {
          status: response.status,
          statusText: response.statusText,
          error: error
        });
      }
    } catch (error) {
      console.error('[AUTH] Error registering user:', error);
    }
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
    if (!user?.fid) {
      return;
    }

    try {
      const response = await fetch(
        `/api/auth/signers?fid=${user.fid}`
      );

      if (!response.ok) {
        throw new Error('Failed to fetch signers');
      }

      const data = await response.json() as { signers: NeynarSigner[] };
      const signersArray = Array.isArray(data.signers) ? data.signers : [];
      setSigners(signersArray);
      
      // Update user with signers
      setUser(prev => prev ? { ...prev, signers: signersArray } : null);
    } catch (error) {
      console.error('[AUTH] Error refreshing signers:', error);
      // Set empty array on error to prevent undefined issues
      setSigners([]);
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
        setPendingSignerUuid(null);
        return;
      }

      try {
        const response = await fetch(`/api/auth/signer?signerUuid=${pendingSignerUuid}`);
        
        if (!response.ok) return;

        const signer = await response.json() as NeynarSigner;

        if (signer.status === 'approved') {
          cleanup();
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
      setPendingSignerUuid(null);
    }, 300000);

    return cleanup;
  }, [pendingSignerUuid]);

  // Computed values with defensive checks
  const hasSigner = Array.isArray(signers) && signers.some(s => s.status === 'approved');
  const activeSigner = Array.isArray(signers) ? signers.find(s => s.status === 'approved') || null : null;

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
        setUserData,
        getAuthToken,
        addMiniApp,
        handleWebAuth,
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
