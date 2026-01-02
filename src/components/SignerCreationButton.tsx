/**
 * SignerCreationButton Component
 * 
 * Handles creation of a Farcaster signer for already-authenticated users.
 * Manages the signer creation flow: signer generation, registration, approval, and polling.
 * 
 * Usage:
 * <SignerCreationButton 
 *   onSuccess={() => console.log('Signer created!')}
 *   onError={(error) => console.error('Error:', error)}
 * />
 */

import React, { useState, useEffect, useRef } from 'react';
import { sdk } from '@farcaster/miniapp-sdk';
import { useAuth } from '../context/AuthContext';
import { apiClient } from '../lib/apiClient';
import type { NeynarSigner } from '../lib/types';
import './NeynarAuthButton.css';

type SignerState = 
  | 'idle'
  | 'creating_signer'
  | 'pending_approval'
  | 'polling'
  | 'approved';

interface SignerCreationButtonProps {
  onSuccess?: (signers: NeynarSigner[]) => void;
  onError?: (error: Error) => void;
}

export const SignerCreationButton: React.FC<SignerCreationButtonProps> = ({
  onSuccess,
  onError,
}) => {
  const { isMiniApp, hasSigner, signers, refreshSigners } = useAuth();
  const [signerState, setSignerState] = useState<SignerState>('idle');
  const [approvalUrl, setApprovalUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pollAttempts, setPollAttempts] = useState(0);
  const [showManualLink, setShowManualLink] = useState(false);
  
  // Refs for cleanup
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const pollTimeoutRef = useRef<NodeJS.Timeout | null>(null);

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

  // Handle page visibility changes (important for mobile)
  // When user returns from Farcaster app, polling continues automatically
  useEffect(() => {
    const handleVisibilityChange = () => {
      // Polling continues automatically in the background
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [signerState]);

  // Create and register signer
  const handleCreateSigner = async () => {
    try {
      setError(null);
      setSignerState('creating_signer');

      // Create signer using apiClient (handles MiniApp and web auth automatically)
      const createResponse = await apiClient.post('/api/auth/signer', {});

      if (!createResponse.ok) {
        const errorText = await createResponse.text();
        console.error('[Signer] Create signer failed:', createResponse.status, errorText);
        throw new Error(`Failed to create signer: ${errorText}`);
      }

      const signer = await createResponse.json() as NeynarSigner;

      // Register signed key
      const registerResponse = await apiClient.post('/api/auth/signer/register', {
        signerUuid: signer.signer_uuid,
        publicKey: signer.public_key,
      });

      if (!registerResponse.ok) {
        const errorText = await registerResponse.text();
        console.error('[Signer] Register signer failed:', registerResponse.status, errorText);
        throw new Error(`Failed to register signed key: ${errorText}`);
      }

      const result = await registerResponse.json() as { signer_approval_url: string };
      setApprovalUrl(result.signer_approval_url);
      setSignerState('pending_approval');

      // Start polling
      startPolling(signer.signer_uuid);
    } catch (err) {
      console.error('[Signer] Error creating signer:', err);
      setError(err instanceof Error ? err.message : 'Failed to create signer');
      setSignerState('idle');
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
    setSignerState('polling');
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
        setSignerState('idle');
        return;
      }

      try {
        // Poll signer status using apiClient
        const response = await apiClient.get(`/api/auth/signer?signerUuid=${signerUuid}`);

        if (!response.ok) {
          return;
        }

        const signer = await response.json() as NeynarSigner;

        if (signer.status === 'approved') {
          cleanup();
          setSignerState('approved');
          setApprovalUrl(null);
          
          // Refresh signers and wait for the updated list
          await refreshSigners();
          
          // Call success callback
          onSuccess?.(signers || []);
        } else {
          // Adjust interval based on elapsed attempts
          const newInterval = getPollingInterval(attempts);
          if (newInterval !== currentInterval) {
            currentInterval = newInterval;
            reschedulePolling();
          }
        }
      } catch (err) {
        console.error('[Signer] Error polling signer:', err);
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
      if (signerState === 'polling') {
        setError('Signer approval timed out. Please try again.');
        setSignerState('idle');
      }
    }, TOTAL_TIMEOUT);
  };

  // Handle approval URL click/scan
  const handleApprovalClick = async () => {
    if (!approvalUrl) return;

    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
      navigator.userAgent
    );

    if (isMiniApp) {
      // In MiniApp: Use SDK to open the URL
      // The approval URL should open Farcaster to the approval screen
      try {
        await sdk.actions.openUrl(approvalUrl);
        
        // Show manual link after a delay in case the URL didn't open
        setTimeout(() => {
          setShowManualLink(true);
        }, 2000);
      } catch (err) {
        console.error('[Signer] Failed to open approval URL:', err);
        setShowManualLink(true);
        // Fallback: try to open with window.open
        window.open(approvalUrl, '_blank');
      }
    } else if (isMobile) {
      // Mobile web: Open in new tab
      window.open(approvalUrl, '_blank');
    } else {
      // Desktop: QR code is displayed below, but allow clicking to open too
      window.open(approvalUrl, '_blank');
    }
  };

  // Render based on signer state
  const renderContent = () => {
    switch (signerState) {
      case 'idle':
        return (
          <button onClick={handleCreateSigner} className="neynar-auth-button">
            Create Signer
          </button>
        );

      case 'creating_signer':
        return (
          <div className="neynar-auth-loading">
            <div className="spinner" />
            <p>Creating signer...</p>
          </div>
        );

      case 'pending_approval':
      case 'polling':
        return (
          <div className="neynar-auth-approval">
            <h3>Approve Signer</h3>
            {isMiniApp ? (
              <p>Click the button below to open the approval screen in Farcaster</p>
            ) : (
              <p>Scan the QR code or click the button to approve the signer in Farcaster</p>
            )}
            
            {approvalUrl && (
              <>
                {!isMiniApp && (
                  <div className="qr-code-container">
                    <img
                      src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(approvalUrl)}`}
                      alt="Approval QR Code"
                    />
                  </div>
                )}
                
                <button onClick={handleApprovalClick} className="approval-button">
                  {isMiniApp ? 'Open Approval Screen' : 'Open in Farcaster'}
                </button>
                
                {isMiniApp && showManualLink && (
                  <div style={{ marginTop: '12px', fontSize: '12px', wordBreak: 'break-all' }}>
                    <p style={{ marginBottom: '4px', opacity: 0.7 }}>Or copy this link:</p>
                    <input 
                      type="text" 
                      readOnly 
                      value={approvalUrl}
                      onClick={(e) => (e.target as HTMLInputElement).select()}
                      style={{ 
                        width: '100%', 
                        padding: '8px', 
                        fontSize: '11px',
                        fontFamily: 'monospace',
                        border: '1px solid rgba(124, 101, 193, 0.3)',
                        borderRadius: '4px',
                        background: 'rgba(124, 101, 193, 0.05)'
                      }}
                    />
                  </div>
                )}
              </>
            )}

            <div className="polling-indicator">
              <div className="spinner small" />
              <p>Waiting for approval... {pollAttempts > 0 && `(${pollAttempts} checks)`}</p>
            </div>
          </div>
        );

      case 'approved':
        return (
          <div className="neynar-auth-success">
            <span className="status-badge">✓ Signer Created</span>
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

export default SignerCreationButton;

