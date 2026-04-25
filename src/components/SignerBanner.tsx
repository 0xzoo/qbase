import React, { useState, useEffect, useCallback } from 'react';
import { X, Link as LinkIcon } from 'lucide-react';
import { sdk } from '@farcaster/miniapp-sdk';
import { useAuth } from '../context/AuthContext';
import './SignerBanner.css';

const DISMISSED_KEY = 'qbase_signer_banner_dismissed';
const POLL_INTERVAL = 3000;
const POLL_TIMEOUT = 120_000;

const SignerBanner: React.FC = () => {
  const { isAuthenticated, getAuthToken } = useAuth();
  const [dismissed, setDismissed] = useState(() =>
    sessionStorage.getItem(DISMISSED_KEY) === '1'
  );
  const [hasApprovedSigner, setHasApprovedSigner] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);

  // Check existing signers
  useEffect(() => {
    if (!isAuthenticated) { setIsLoading(false); return; }
    const token = getAuthToken();
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    fetch('/api/farcaster/signer/list', { headers })
      .then(r => r.json())
      .then((data: any) => {
        const signers = data.signers || [];
        setHasApprovedSigner(signers.some((s: any) => s.status === 'approved'));
      })
      .catch(() => {})
      .finally(() => setIsLoading(false));
  }, [isAuthenticated, getAuthToken]);

  const handleConnect = useCallback(async () => {
    setConnecting(true);

    // Open /connect page in Farcaster's browser — handles SIWN flow there
    const connectUrl = `${window.location.origin}/connect`;
    try {
      await sdk.actions.openUrl(connectUrl);
    } catch {
      window.open(connectUrl, '_blank');
    }

    // Poll for new approved signer
    const token = getAuthToken();
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const start = Date.now();

    while (Date.now() - start < POLL_TIMEOUT) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
      try {
        const res = await fetch('/api/farcaster/signer/list', { headers });
        const data = await res.json() as { signers: { status: string }[] };
        const approved = (data.signers || []).some(s => s.status === 'approved');
        if (approved) {
          setHasApprovedSigner(true);
          sessionStorage.removeItem(DISMISSED_KEY);
          setConnecting(false);
          return;
        }
      } catch { /* ignore */ }
    }

    setConnecting(false);
  }, [getAuthToken]);

  const handleDismiss = () => {
    setDismissed(true);
    sessionStorage.setItem(DISMISSED_KEY, '1');
  };

  if (isLoading || !isAuthenticated || hasApprovedSigner || dismissed) return null;

  return (
    <div className="signer-banner">
      <div className="signer-banner__content">
        <span className="signer-banner__text">
          {connecting
            ? 'Waiting for Farcaster approval... (check the browser)'
            : 'Connect Farcaster to post as you'}
        </span>
        {!connecting && (
          <button className="signer-banner__action" onClick={handleConnect}>
            <LinkIcon size={14} />
            Connect
          </button>
        )}
      </div>
      <button className="signer-banner__dismiss" onClick={handleDismiss}>
        <X size={16} />
      </button>
    </div>
  );
};

export default SignerBanner;
