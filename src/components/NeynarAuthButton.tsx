/**
 * NeynarAuthButton Component
 * 
 * Handles Neynar-based Farcaster authentication for both web and miniapp contexts.
 * Manages the complete signer flow: nonce generation, SIWF signing, signer creation,
 * approval, and polling.
 * 
 * Usage:
 * <NeynarAuthButton />
 */

import React, { useState, useEffect, useRef } from 'react';
import { sdk } from '@farcaster/miniapp-sdk';
import { useSignIn } from '@farcaster/auth-kit';
import { useAuth } from '../context/AuthContext';
import type { NeynarSigner } from '../lib/types';
import './NeynarAuthButton.css';

type AuthState = 
  | 'unauthenticated'
  | 'fetching_nonce'
  | 'signing'
  | 'fetching_signers'
  | 'creating_signer'
  | 'pending_approval'
  | 'polling'
  | 'authenticated';

interface NeynarAuthButtonProps {
  onSuccess?: (signers: NeynarSigner[]) => void;
  onError?: (error: Error) => void;
}

export const NeynarAuthButton: React.FC<NeynarAuthButtonProps> = ({
  onSuccess,
  onError,
}) => {
  const { user, isMiniApp, hasSigner, signers, refreshSigners } = useAuth();
  const [authState, setAuthState] = useState<AuthState>('unauthenticated');
  const [nonce, setNonce] = useState<string | null>(null);
  const [approvalUrl, setApprovalUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pollAttempts, setPollAttempts] = useState(0);
  
  // Refs for cleanup
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const pollTimeoutRef = useRef<NodeJS.Timeout | null>(null);

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

  // Check if already authenticated with approved signer
  useEffect(() => {
    if (hasSigner && signers && signers.length > 0) {
      setAuthState('authenticated');
      onSuccess?.(signers);
    }
  }, [hasSigner, signers]);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
      if (pollTimeoutRef.current) {
        clearTimeout(pollTimeoutRef.current);
      }
    };
  }, []);

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

  // Handle successful SIWF signing
  const handleSIWFSuccess = async (message: string, signature: string) => {
    try {
      setAuthState('fetching_signers');

      // Fetch existing signers
      const response = await fetch(
        `/api/auth/signers?message=${encodeURIComponent(message)}&signature=${signature}`
      );

      if (!response.ok) {
        throw new Error('Failed to fetch signers');
      }

      const data = await response.json() as { signers: NeynarSigner[] };
      const existingSigners = data.signers || [];

      // Check if user has approved signers
      const hasApprovedSigner = existingSigners.some(
        (s: NeynarSigner) => s.status === 'approved'
      );

      if (hasApprovedSigner) {
        // User already has approved signer
        setAuthState('authenticated');
        await refreshSigners();
        onSuccess?.(existingSigners);
      } else {
        // Need to create new signer
        await handleCreateSigner();
      }
    } catch (err) {
      console.error('Error handling SIWF success:', err);
      setError('Failed to process authentication');
      setAuthState('unauthenticated');
      onError?.(err as Error);
    }
  };

  // Create and register signer
  const handleCreateSigner = async () => {
    try {
      setAuthState('creating_signer');

      // Create signer
      const createResponse = await fetch('/api/auth/signer', {
        method: 'POST',
      });

      if (!createResponse.ok) {
        throw new Error('Failed to create signer');
      }

      const signer = await createResponse.json() as NeynarSigner;

      // Register signed key
      const registerResponse = await fetch('/api/auth/signer/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          signerUuid: signer.signer_uuid,
          publicKey: signer.public_key,
        }),
      });

      if (!registerResponse.ok) {
        throw new Error('Failed to register signed key');
      }

      const result = await registerResponse.json() as { signer_approval_url: string };
      setApprovalUrl(result.signer_approval_url);
      setAuthState('pending_approval');

      // Start polling
      startPolling(signer.signer_uuid);
    } catch (err) {
      console.error('Error creating signer:', err);
      setError('Failed to create signer');
      setAuthState('unauthenticated');
      onError?.(err as Error);
    }
  };

  /**
   * Optimized polling with exponential backoff
   * Reduces API calls from ~150 to ~50-75 per approval
   * 
   * Strategy:
   * - 0-20s: Poll every 1s (20 calls) - user actively scanning/approving
   * - 20-60s: Poll every 2s (20 calls) - approval in progress
   * - 60-120s: Poll every 5s (12 calls) - slower fallback
   * - 120-300s: Poll every 10s (18 calls) - final fallback
   * Total: ~70 calls vs 150 with fixed 2s interval (53% reduction)
   */
  const startPolling = (signerUuid: string) => {
    setAuthState('polling');
    setPollAttempts(0);
    
    // Clear any existing polling
    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    if (pollTimeoutRef.current) clearTimeout(pollTimeoutRef.current);

    const MAX_ATTEMPTS = 75;
    const TOTAL_TIMEOUT = 300000; // 5 minutes
    let attempts = 0;
    let currentInterval = 1000; // Start with 1s
    
    const pollSigner = async () => {
      attempts++;
      setPollAttempts(attempts);
      
      // Check max attempts
      if (attempts > MAX_ATTEMPTS) {
        cleanup();
        setError('Signer approval timed out. Please try again.');
        setAuthState('unauthenticated');
        return;
      }

      try {
        const response = await fetch(`/api/auth/signer?signerUuid=${signerUuid}`);

        if (!response.ok) {
          console.warn(`Poll attempt ${attempts} failed with status ${response.status}`);
          return;
        }

        const signer = await response.json() as NeynarSigner;

        if (signer.status === 'approved') {
          cleanup();
          setAuthState('authenticated');
          setApprovalUrl(null);
          await refreshSigners();
          onSuccess?.(signers || []);
          console.log(`✅ Signer approved after ${attempts} attempts`);
        } else {
          // Adjust interval based on elapsed attempts
          const newInterval = getPollingInterval(attempts);
          if (newInterval !== currentInterval) {
            currentInterval = newInterval;
            reschedulePolling();
          }
        }
      } catch (err) {
        console.error(`Error polling signer (attempt ${attempts}):`, err);
      }
    };

    const getPollingInterval = (attempt: number): number => {
      // 0-20 attempts (0-20s): 1s interval
      if (attempt <= 20) return 1000;
      // 21-40 attempts (20-60s): 2s interval
      if (attempt <= 40) return 2000;
      // 41-52 attempts (60-120s): 5s interval
      if (attempt <= 52) return 5000;
      // 53-75 attempts (120-300s): 10s interval
      return 10000;
    };

    const reschedulePolling = () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
      pollIntervalRef.current = setInterval(pollSigner, currentInterval);
    };

    const cleanup = () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
      if (pollTimeoutRef.current) {
        clearTimeout(pollTimeoutRef.current);
        pollTimeoutRef.current = null;
      }
    };

    // Start polling
    pollIntervalRef.current = setInterval(pollSigner, currentInterval);

    // Safety timeout after 5 minutes
    pollTimeoutRef.current = setTimeout(() => {
      cleanup();
      if (authState === 'polling') {
        setError('Signer approval timed out. Please try again.');
        setAuthState('unauthenticated');
        console.log(`⏱️ Polling timed out after ${attempts} attempts`);
      }
    }, TOTAL_TIMEOUT);
  };

  // Handle approval URL click/scan
  const handleApprovalClick = () => {
    if (!approvalUrl) return;

    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
      navigator.userAgent
    );

    if (isMobile && isMiniApp) {
      // Convert to Warpcast deep link
      const warpcastUrl = approvalUrl.replace(
        'https://client.farcaster.xyz/deeplinks/signed-key-request',
        'https://warpcast.com/~/add-cast-action'
      );
      sdk.actions.openUrl(warpcastUrl);
    } else if (isMobile) {
      // Open in new tab for mobile web
      window.open(approvalUrl, '_blank');
    }
    // Desktop: QR code is displayed below
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
      case 'fetching_signers':
      case 'creating_signer':
        return (
          <div className="neynar-auth-loading">
            <div className="spinner" />
            <p>{authState === 'signing' ? 'Waiting for signature...' : 'Loading...'}</p>
          </div>
        );

      case 'pending_approval':
      case 'polling':
        return (
          <div className="neynar-auth-approval">
            <h3>Approve Signer</h3>
            <p>Scan the QR code or click the button to approve the signer in Warpcast</p>
            
            {approvalUrl && (
              <>
                <div className="qr-code-container">
                  <img
                    src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(approvalUrl)}`}
                    alt="Approval QR Code"
                  />
                </div>
                
                <button onClick={handleApprovalClick} className="approval-button">
                  Open in Warpcast
                </button>
              </>
            )}

            <div className="polling-indicator">
              <div className="spinner small" />
              <p>Waiting for approval... {pollAttempts > 0 && `(${pollAttempts} checks)`}</p>
            </div>
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

