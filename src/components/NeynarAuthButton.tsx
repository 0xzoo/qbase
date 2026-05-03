/**
 * NeynarAuthButton Component
 * 
 * Handles Neynar-based Quick Auth SIWF authentication for both web and miniapp contexts.
 * 
 * Usage:
 * <NeynarAuthButton />
 */

import React, { useState } from 'react';
import { sdk } from '@farcaster/miniapp-sdk';
import { useSignIn } from '@farcaster/auth-kit';
import { useAuth } from '../context/AuthContext';
import './NeynarAuthButton.css';

type AuthState = 'unauthenticated'
  | 'fetching_nonce'
  | 'signing'
  | 'authenticated';

interface NeynarAuthButtonProps {
  onSuccess?: () => void;
  onError?: (error: Error) => void;
}

export const NeynarAuthButton: React.FC<NeynarAuthButtonProps> = ({
  onSuccess,
  onError,
}) => {
  const { user, isMiniApp } = useAuth();
  const [authState, setAuthState] = useState<AuthState>('unauthenticated');
  const [nonce, setNonce] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // AuthKit for web flow
  const {
    signIn
  } = useSignIn({
    nonce: nonce || undefined,
    onSuccess: async (res) => {
      console.log('✅ SIWF successful:', res);
      if (!res.message || !res.signature) {
        console.error('❌ Missing message or signature in SIWF response');
        setError('Authentication failed: missing credentials');
        setAuthState('unauthenticated');
        return;
      }
      await handleSIWFSuccess(res.message, res.signature);
    },
    onError: (err) => {
      console.error('❌ SIWF error:', err);
      setError('Failed to sign in with Farcaster');
      setAuthState('unauthenticated');
      onError?.(err as Error);
    },
  });

  // Check if already authenticated
  React.useEffect(() => {
    if (user && user.fid) {
      setAuthState('authenticated');
    }
  }, [user]);

  // Generate nonce
  const generateNonce = async () => {
    try {
      setAuthState('fetching_nonce');
      const response = await fetch('/api/auth/nonce');
      
      if (!response.ok) {
        throw new Error('Failed to fetch nonce');
      }

      const data = await response.json() as { nonce: string };
      setNonce(data.nonce);
      return data.nonce;
    } catch (err) {
      console.error('Error generating nonce:', err);
      setError('Failed to generate authentication nonce');
      setAuthState('unauthenticated');
      throw err;
    }
  };

  // Handle authentication initiation
  const handleAuth = async () => {
    try {
      setError(null);
      
      // Generate nonce first
      const newNonce = await generateNonce();

      if (isMiniApp) {
        // MiniApp flow: use Farcaster SDK
        setAuthState('signing');
        const result = await sdk.actions.signIn({ nonce: newNonce });
        await handleSIWFSuccess(result.message, result.signature);
      } else {
        // Web flow: use Auth Kit
        setAuthState('signing');
        signIn();
      }
    } catch (err) {
      console.error('Error during authentication:', err);
      setError('Authentication failed');
      setAuthState('unauthenticated');
      onError?.(err as Error);
    }
  };

  // Handle successful SIWF signing - exchange for session token
  const handleSIWFSuccess = async (message: string, signature: string) => {
    try {
      // Exchange SIWF credentials for session token via API
      const response = await fetch('/api/auth/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, signature, nonce }),
      });

      if (!response.ok) {
        throw new Error('Failed to exchange credentials for session');
      }

      await response.json();

      // The AuthContext will handle the response and update user state
      // For Quick Auth, we trigger a login which will use the session token
      setAuthState('authenticated');
      onSuccess?.();
    } catch (err) {
      console.error('Error handling SIWF success:', err);
      setError('Failed to process authentication');
      setAuthState('unauthenticated');
      onError?.(err as Error);
    }
  };

  // Render based on auth state
  const renderContent = () => {
    switch (authState) {
      case 'unauthenticated':
        return (
          <button onClick={handleAuth} className="neynar-auth-button">
            Sign in with Farcaster
          </button>
        );

      case 'fetching_nonce':
      case 'signing':
        return (
          <div className="neynar-auth-loading">
            <div className="spinner" />
            <p>{authState === 'signing' ? 'Waiting for signature...' : 'Loading...'}</p>
          </div>
        );

      case 'authenticated':
        return (
          <div className="neynar-auth-success">
            <div className="user-profile">
              {user?.pfpUrl && (
                <img src={user.pfpUrl} alt={user.username} className="profile-pic" />
              )}
              <div className="user-info">
                <p className="display-name">{user?.displayName}</p>
                <p className="username">@{user?.username}</p>
              </div>
            </div>
            <span className="status-badge">✓ Connected</span>
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <div className="neynar-auth-container">
      {error && (
        <div className="error-message">
          <span>⚠️ {error}</span>
          <button onClick={() => setError(null)}>×</button>
        </div>
      )}
      {renderContent()}
    </div>
  );
};

export default NeynarAuthButton;
