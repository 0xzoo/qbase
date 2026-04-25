import React, { useState, useEffect, useCallback } from 'react';
import { X, Link as LinkIcon } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import './SignerBanner.css';

const DISMISSED_KEY = 'qbase_signer_banner_dismissed';
const POLL_INTERVAL = 5000;
const POLL_TIMEOUT = 300_000;

const SignerBanner: React.FC = () => {
  const { isAuthenticated, getAuthToken } = useAuth();
  const [dismissed, setDismissed] = useState(() =>
    sessionStorage.getItem(DISMISSED_KEY) === '1'
  );
  const [hasApprovedSigner, setHasApprovedSigner] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [polling, setPolling] = useState(false);

  // Check existing signers
  const checkSigners = useCallback(async () => {
    if (!isAuthenticated) return false;
    const token = getAuthToken();
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    try {
      const res = await fetch('/api/farcaster/signer/list', { headers });
      const data = await res.json() as { signers: { status: string }[] };
      return (data.signers || []).some(s => s.status === 'approved');
    } catch { return false; }
  }, [isAuthenticated, getAuthToken]);

  useEffect(() => {
    if (!isAuthenticated) { setIsLoading(false); return; }
    checkSigners().then(approved => {
      setHasApprovedSigner(approved);
      setIsLoading(false);
    });
  }, [isAuthenticated, checkSigners]);

  // Start polling when user taps Connect (they'll open /connect in their browser)
  const handleConnect = useCallback(() => {
    setPolling(true);
    const start = Date.now();

    const poll = async () => {
      while (Date.now() - start < POLL_TIMEOUT) {
        await new Promise(r => setTimeout(r, POLL_INTERVAL));
        const approved = await checkSigners();
        if (approved) {
          setHasApprovedSigner(true);
          sessionStorage.removeItem(DISMISSED_KEY);
          setPolling(false);
          return;
        }
      }
      setPolling(false);
    };
    poll();
  }, [checkSigners]);

  const handleDismiss = () => {
    setDismissed(true);
    sessionStorage.setItem(DISMISSED_KEY, '1');
  };

  if (isLoading || !isAuthenticated || hasApprovedSigner || dismissed) return null;

  const connectUrl = `${window.location.origin}/connect`;

  return (
    <div className="signer-banner">
      <div className="signer-banner__content">
        {polling ? (
          <>
            <span className="signer-banner__text">
              Waiting for connection... (complete on qbase.tech/connect)
            </span>
          </>
        ) : (
          <>
            <span className="signer-banner__text">
              Connect Farcaster to post as you
            </span>
            <a
              className="signer-banner__action"
              href={connectUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={handleConnect}
            >
              <LinkIcon size={14} />
              Connect
            </a>
          </>
        )}
      </div>
      <button className="signer-banner__dismiss" onClick={handleDismiss}>
        <X size={16} />
      </button>
    </div>
  );
};

export default SignerBanner;
