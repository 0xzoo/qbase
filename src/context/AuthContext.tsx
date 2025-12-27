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
  isLoading: boolean;
  login: () => void;
  logout: () => void;
  getAuthToken: () => string | null; // Helper to get auth token for API requests
  // Signer management
  signers: NeynarSigner[] | null;
  hasSigner: boolean;
  createSigner: () => Promise<void>;
  refreshSigners: () => Promise<void>;
  activeSigner: NeynarSigner | null;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [isMiniApp, setIsMiniApp] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [signers, setSigners] = useState<NeynarSigner[] | null>(null);
  const [pendingSignerUuid, setPendingSignerUuid] = useState<string | null>(null);

  // AuthKit hooks for web
  const {
    signIn,
    signOut,
    isSuccess: isWebAuthenticated
  } = useSignIn({
    onSuccess: (res) => {
      console.log('[AUTH] Web sign-in successful:', res);
    },
    onError: (error) => {
      console.error('[AUTH] Web sign-in error:', error);
    },
  });
  const { profile: webUser } = useProfile();

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

          sdk.on("miniAppAdded", ({ notificationDetails }) => {
            console.log("MiniApp added:", notificationDetails);
          });

          sdk.on("miniAppAddRejected", () => {
            console.log("MiniApp add rejected");
          });

          sdk.on("miniAppRemoved", () => {
            console.log("MiniApp removed");
          });

          sdk.on("notificationsEnabled", ({ notificationDetails }) => {
            console.log("Notifications enabled:", notificationDetails);
          });

          sdk.on("notificationsDisabled", () => {
            console.log("Notifications disabled");
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
      signIn();
    }
  };

  const logout = () => {
    if (isMiniApp) {
      // MiniApp logout logic if needed
      setUser(null);
    } else {
      signOut();
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

  // Poll for signer approval
  useEffect(() => {
    if (!pendingSignerUuid) return;

    const pollInterval = setInterval(async () => {
      try {
        const response = await fetch(`/api/auth/signer?signerUuid=${pendingSignerUuid}`);
        
        if (!response.ok) return;

        const signer = await response.json() as NeynarSigner;

        if (signer.status === 'approved') {
          clearInterval(pollInterval);
          setPendingSignerUuid(null);
          await refreshSigners();
        }
      } catch (error) {
        console.error('Error polling signer:', error);
      }
    }, 2000); // Poll every 2 seconds

    return () => clearInterval(pollInterval);
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
        isLoading,
        login,
        logout,
        getAuthToken,
        signers,
        hasSigner,
        createSigner,
        refreshSigners,
        activeSigner,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
