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
  const [approvalUrl, setApprovalUrl] = useState<string | null>(null);

  // Reset dismissed state if signer becomes approved
  useEffect(() => {
    if (hasApprovedSigner) {
      sessionStorage.removeItem(DISMISSED_KEY);
    }
  }, [hasApprovedSigner]);

  const handleConnect = useCallback(async () => {
    try {
      setConnecting(true);
      const { approvalUrl: url, signerUuid } = await createSigner();

      // Store the URL so user can tap it in the waiting state
      setApprovalUrl(url);

      // Try opening in new tab (may fail in miniapp WebView)
      try {
        window.open(url, '_blank');
      } catch {
        // Ignore — user can tap the link in the banner
      }

      // Start polling
      setConnecting(false);
      setWaitingApproval(true);

      const approved = await pollUntilApproved(signerUuid, 120_000);
      if (approved) {
        setWaitingApproval(false);
        setApprovalUrl(null);
        sessionStorage.removeItem(DISMISSED_KEY);
      } else {
        setWaitingApproval(false);
      }
    } catch (e: any) {
      console.error('[SignerBanner] Failed to create signer:', e);
      setConnecting(false);
      setWaitingApproval(false);
      setApprovalUrl(null);
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
          {approvalUrl && (
            <a
              className="signer-banner__action"
              href={approvalUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Approve
            </a>
          )}
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
