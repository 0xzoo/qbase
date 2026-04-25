import React, { useState, useEffect, useCallback, useRef } from 'react';
import { X, Link as LinkIcon } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import './SignerBanner.css';

const DISMISSED_KEY = 'qbase_signer_banner_dismissed';
const SIWN_ORIGIN = 'https://app.neynar.com';

const SignerBanner: React.FC = () => {
  const { isAuthenticated, getAuthToken } = useAuth();
  const [dismissed, setDismissed] = useState(() => {
    return sessionStorage.getItem(DISMISSED_KEY) === '1';
  });
  const [hasApprovedSigner, setHasApprovedSigner] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [clientId, setClientId] = useState<string | null>(null);
  const popupRef = useRef<Window | null>(null);

  // Check for existing approved signers + fetch SIWN client ID
  useEffect(() => {
    if (!isAuthenticated) {
      setIsLoading(false);
      return;
    }

    const token = getAuthToken();
    const headers = token ? { Authorization: `Bearer ${token}` } : {};

    Promise.all([
      fetch('/api/farcaster/signer/list', { headers }).then(r => r.json()),
      fetch('/api/farcaster/signer/siwn-config').then(r => r.json()).catch(() => ({ client_id: '' })),
    ]).then(([signerData, configData]) => {
      const signers = (signerData as { signers: { status: string }[] }).signers || [];
      const approved = signers.some((s: { status: string }) => s.status === 'approved');
      setHasApprovedSigner(approved);
      setClientId((configData as { client_id: string }).client_id || null);
    }).catch(() => {
      // Ignore errors — just show the banner
    }).finally(() => {
      setIsLoading(false);
    });
  }, [isAuthenticated, getAuthToken]);

  // Listen for SIWN postMessage callback
  useEffect(() => {
    if (!connecting) return;

    const handleMessage = async (event: MessageEvent) => {
      if (event.origin !== SIWN_ORIGIN) return;
      if (!event.data?.is_authenticated) return;

      const { signer_uuid, fid } = event.data;
      if (!signer_uuid) return;

      // Close popup if still open
      if (popupRef.current && !popupRef.current.closed) {
        popupRef.current.close();
      }
      popupRef.current = null;

      // Save signer to D1
      try {
        const token = getAuthToken();
        const res = await fetch('/api/farcaster/signer/save', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ signer_uuid, fid }),
        });

        if (res.ok) {
          setHasApprovedSigner(true);
          sessionStorage.removeItem(DISMISSED_KEY);
        }
      } catch (e) {
        console.error('[SignerBanner] Failed to save signer:', e);
      }

      setConnecting(false);
      window.removeEventListener('message', handleMessage);
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [connecting, getAuthToken]);

  const handleConnect = useCallback(() => {
    if (!clientId) {
      console.error('[SignerBanner] No NEYNAR_CLIENT_ID configured');
      return;
    }

    setConnecting(true);
    const url = `${SIWN_ORIGIN}/login?client_id=${encodeURIComponent(clientId)}`;
    popupRef.current = window.open(url, '_blank', 'width=600,height=700');
  }, [clientId]);

  const handleDismiss = () => {
    setDismissed(true);
    sessionStorage.setItem(DISMISSED_KEY, '1');
  };

  // Don't show if loading, not authenticated, has signer, or dismissed
  if (isLoading || !isAuthenticated || hasApprovedSigner || dismissed) {
    return null;
  }

  return (
    <div className="signer-banner">
      <div className="signer-banner__content">
        <span className="signer-banner__text">
          {connecting
            ? 'Complete sign-in in the popup...'
            : 'Connect Farcaster to post as you'}
        </span>
        {!connecting && (
          <button
            className="signer-banner__action"
            onClick={handleConnect}
            disabled={!clientId}
          >
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
