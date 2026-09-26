import React, { useState, useEffect, useCallback, useRef } from 'react';
import { X, Link as LinkIcon } from 'lucide-react';
import { sdk } from '@farcaster/miniapp-sdk';
import { useAuth } from '../context/AuthContext';
import './SignerBanner.css';

const DISMISSED_KEY = 'qbase_signer_banner_dismissed';
const POLL_INTERVAL = 3000;
const POLL_TIMEOUT = 120_000;

const SignerBanner: React.FC = () => {
  const { isAuthenticated, getAuthToken, isMiniApp, fid } = useAuth();
  const [dismissed, setDismissed] = useState(() =>
    sessionStorage.getItem(DISMISSED_KEY) === '1'
  );
  const [hasApprovedSigner, setHasApprovedSigner] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [clientId, setClientId] = useState<string | null>(null);
  const initialSignerCountRef = useRef(0);

  // Check existing signers + fetch client ID
  useEffect(() => {
    if (!isAuthenticated) { setIsLoading(false); return; }
    const token = getAuthToken();
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    Promise.all([
      fetch('/api/farcaster/signer/list', { headers }).then(r => r.json()),
      fetch('/api/farcaster/signer/siwn-config').then(r => r.json()).catch(() => ({ client_id: '' })),
    ]).then(([signerData, configData]) => {
      const signers = (signerData as any).signers || [];
      setHasApprovedSigner(signers.some((s: any) => s.status === 'approved'));
      initialSignerCountRef.current = signers.length;
      setClientId((configData as any).client_id || null);
    }).catch(() => {}).finally(() => setIsLoading(false));
  }, [isAuthenticated, getAuthToken]);

  const handleConnect = useCallback(async () => {
    if (!clientId) return;
    setConnecting(true);

    // Open SIWN — miniapp uses Farcaster browser, web uses popup
    const connectUrl = `https://qbase.tech/connect`;
    if (isMiniApp) {
      await sdk.actions.openUrl(connectUrl);
    } else {
      window.open(connectUrl, '_blank', 'width=600,height=700');
    }

    // Poll for new signer — SIWN creates an approved signer on success
    const token = getAuthToken();
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const start = Date.now();

    const poll = async () => {
      while (Date.now() - start < POLL_TIMEOUT) {
        await new Promise(r => setTimeout(r, POLL_INTERVAL));
        try {
          const res = await fetch('/api/farcaster/signer/list', { headers });
          const data = await res.json() as { signers: { status: string; signer_uuid: string }[] };
          const signers = data.signers || [];

          // Check if a new signer appeared
          if (signers.length > initialSignerCountRef.current) {
            const newSigner = signers[0]; // Most recent
            if (newSigner?.status === 'approved') {
              // Already approved — save it
              await fetch('/api/farcaster/signer/save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...headers },
                body: JSON.stringify({ signer_uuid: newSigner.signer_uuid }),
              });
              setHasApprovedSigner(true);
              sessionStorage.removeItem(DISMISSED_KEY);
              setConnecting(false);
              return;
            }
          }

          // Also check if any existing signer became approved
          const approved = signers.some(s => s.status === 'approved');
          if (approved) {
            setHasApprovedSigner(true);
            sessionStorage.removeItem(DISMISSED_KEY);
            setConnecting(false);
            return;
          }
        } catch {
          // Ignore poll errors
        }
      }
      // Timed out
      setConnecting(false);
    };

    poll();
  }, [clientId, getAuthToken, isMiniApp]);

  const handleDismiss = () => {
    setDismissed(true);
    sessionStorage.setItem(DISMISSED_KEY, '1');
  };

  // Posting as yourself is a Farcaster signer: an account signed in with a
  // wallet, World ID or a passkey and no linked Farcaster has nothing to connect.
  if (isLoading || !isAuthenticated || !fid || hasApprovedSigner || dismissed) return null;

  return (
    <div className="signer-banner">
      <div className="signer-banner__content">
        <span className="signer-banner__text">
          {connecting
            ? 'Waiting for Farcaster approval... (check the browser)'
            : 'Connect Farcaster to post as you'}
        </span>
        {!connecting && (
          <button className="signer-banner__action" onClick={handleConnect} disabled={!clientId}>
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
