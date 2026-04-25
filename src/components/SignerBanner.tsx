import React, { useState, useEffect, useCallback } from 'react';
import { X, Link as LinkIcon } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useSigner } from '../hooks/useSigner';
import './SignerBanner.css';

const DISMISSED_KEY = 'qbase_signer_banner_dismissed';

const SignerBanner: React.FC = () => {
  const { isAuthenticated } = useAuth();
  const { hasApprovedSigner, isLoading, createSigner, pollUntilApproved } = useSigner();
  const [dismissed, setDismissed] = useState(() => {
    return sessionStorage.getItem(DISMISSED_KEY) === '1';
  });
  const [connecting, setConnecting] = useState(false);
  const [waitingApproval, setWaitingApproval] = useState(false);

  // Reset dismissed state if signer becomes approved
  useEffect(() => {
    if (hasApprovedSigner) {
      sessionStorage.removeItem(DISMISSED_KEY);
    }
  }, [hasApprovedSigner]);

  const handleConnect = useCallback(async () => {
    try {
      setConnecting(true);
      const { approvalUrl, signerUuid } = await createSigner();

      // Open approval URL in new tab
      window.open(approvalUrl, '_blank');

      // Start polling
      setConnecting(false);
      setWaitingApproval(true);

      const approved = await pollUntilApproved(signerUuid, 120_000);
      if (approved) {
        setWaitingApproval(false);
        sessionStorage.removeItem(DISMISSED_KEY);
      } else {
        setWaitingApproval(false);
      }
    } catch (e: any) {
      console.error('[SignerBanner] Failed to create signer:', e);
      setConnecting(false);
      setWaitingApproval(false);
    }
  }, [createSigner, pollUntilApproved]);

  const handleDismiss = () => {
    setDismissed(true);
    sessionStorage.setItem(DISMISSED_KEY, '1');
  };

  // Don't show if loading, not authenticated, has signer, or dismissed
  if (isLoading || !isAuthenticated || hasApprovedSigner || dismissed) {
    return null;
  }

  if (waitingApproval) {
    return (
      <div className="signer-banner signer-banner--waiting">
        <div className="signer-banner__content">
          <span className="signer-banner__text">
            Waiting for Farcaster approval...
          </span>
        </div>
        <button className="signer-banner__dismiss" onClick={handleDismiss}>
          <X size={16} />
        </button>
      </div>
    );
  }

  return (
    <div className="signer-banner">
      <div className="signer-banner__content">
        <span className="signer-banner__text">
          Connect Farcaster to post questions as you
        </span>
        <button
          className="signer-banner__action"
          onClick={handleConnect}
          disabled={connecting}
        >
          <LinkIcon size={14} />
          {connecting ? 'Connecting...' : 'Connect'}
        </button>
      </div>
      <button className="signer-banner__dismiss" onClick={handleDismiss}>
        <X size={16} />
      </button>
    </div>
  );
};

export default SignerBanner;
