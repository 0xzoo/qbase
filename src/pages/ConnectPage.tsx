import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import Header from '../components/Header';
import './ConnectPage.css';

type State = 'need_auth' | 'loading' | 'ready' | 'success' | 'fid_mismatch' | 'error';

/**
 * ConnectPage — Farcaster signer connection via Neynar SIWN.
 *
 * Uses Neynar's official SIWN script (<div class="neynar_signin">) to handle
 * popup lifecycle, cross-origin messaging, and the callback reliably.
 *
 * FID mismatch: if the user authenticates via SIWN as a different Farcaster
 * account than their qbase account, shows a warning instead of blindly saving.
 */
const ConnectPage: React.FC = () => {
  const { isAuthenticated, getAuthToken, user } = useAuth();
  const navigate = useNavigate();
  const [state, setState] = useState<State>('loading');
  const [error, setError] = useState<string | null>(null);
  const [clientId, setClientId] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [connectedFid, setConnectedFid] = useState<number | null>(null);
  const redirectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cleanup redirect timer on unmount
  useEffect(() => {
    return () => {
      if (redirectTimerRef.current) clearTimeout(redirectTimerRef.current);
    };
  }, []);

  // ── Initialization: redirect return, or check auth + signers ──
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const signerUuid = params.get('signer_uuid');
    if (signerUuid) {
      setState('loading');
      const token = getAuthToken();
      fetch('/api/farcaster/signer/save', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          signer_uuid: signerUuid,
          fid: params.get('fid') ? parseInt(params.get('fid')!) : undefined,
        }),
      }).then(res => {
        if (res.ok) {
          window.history.replaceState({}, '', '/connect');
          setState('success');
        } else {
          setError('Failed to save signer');
          setState('error');
        }
      }).catch(() => { setError('Network error'); setState('error'); });
      return;
    }

    if (!isAuthenticated) { setState('need_auth'); return; }

    const token = getAuthToken();
    const headers = token ? { Authorization: `Bearer ${token}` } : {};

    Promise.all([
      fetch('/api/farcaster/signer/siwn-config', { headers }).then(r => r.json()),
      fetch('/api/farcaster/signer/list', { headers }).then(r => r.json()),
    ]).then(([config, listData]: [any, any]) => {
      setClientId(config.client_id || null);
      const approved = (listData.signers || []).some((s: any) => s.status === 'approved');
      setState(approved ? 'success' : 'ready');
    }).catch(() => setState('ready'));
  }, [isAuthenticated, getAuthToken]);

  // ── Auto-redirect on success ──
  useEffect(() => {
    if (state === 'success') {
      redirectTimerRef.current = setTimeout(() => navigate('/questions'), 2000);
    }
    return () => {
      if (redirectTimerRef.current) clearTimeout(redirectTimerRef.current);
    };
  }, [state, navigate]);

  // ── SIWN success callback ──
  const onSignInSuccess = useCallback(async (
    data: { signer_uuid: string; fid: number; is_authenticated?: boolean }
  ) => {
    if (!data?.signer_uuid) return;

    const skipFidCheck = (window as any).__qbaseSkipFidCheck;
    delete (window as any).__qbaseSkipFidCheck;

    // FID mismatch check (unless explicitly overridden)
    if (!skipFidCheck && user?.fid && data.fid && user.fid !== data.fid) {
      setConnectedFid(data.fid);
      setState('fid_mismatch');
      return;
    }

    try {
      const token = getAuthToken();
      const res = await fetch('/api/farcaster/signer/save', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ signer_uuid: data.signer_uuid, fid: data.fid }),
      });
      setState(res.ok ? 'success' : 'error');
      if (!res.ok) setError('Failed to save signer');
    } catch (e: any) {
      setError(e.message || 'Network error');
      setState('error');
    }
  }, [getAuthToken, user?.fid]);

  // ── Force-connect (skip FID check next time) ──
  const handleForceConnect = useCallback(() => {
    (window as any).__qbaseSkipFidCheck = true;
    setRetryKey(k => k + 1);
    setState('ready');
  }, []);

  // ── Expose callback globally for Neynar SIWN script ──
  useEffect(() => {
    (window as any).__qbaseSiwnCallback = onSignInSuccess;
    return () => { delete (window as any).__qbaseSiwnCallback; };
  }, [onSignInSuccess]);

  // ── Load Neynar SIWN script ──
  useEffect(() => {
    if (state !== 'ready' || !clientId) return;
    if (document.querySelector('script[src*="neynarxyz.github.io/siwn"]')) return;

    const script = document.createElement('script');
    script.src = 'https://neynarxyz.github.io/siwn/raw/1.2.0/index.js';
    script.async = true;
    document.body.appendChild(script);
  }, [state, clientId]);

  return (
    <div className="connect-page">
      <Header />
      <div className="connect-container">
        <div className="connect-card">
          <div className="connect-icon">🔮</div>
          <h1 className="connect-title">Connect Farcaster</h1>

          {state === 'need_auth' && (
            <>
              <p className="connect-description">
                Sign in to qbase first, then connect your Farcaster account.
              </p>
              <a href="/" className="connect-btn">Sign in to qbase</a>
            </>
          )}

          {state === 'loading' && (
            <p className="connect-loading">Loading...</p>
          )}

          {state === 'ready' && clientId && (
            <>
              <p className="connect-description">
                Signed in as <strong>@{user?.username || 'user'}</strong>.
                {' '}Make sure you sign in as the same Farcaster account.
              </p>
              <div className="connect-siwn-wrapper">
                <div
                  key={`siwn-${retryKey}`}
                  className="neynar_signin"
                  data-client_id={clientId}
                  data-success-callback="__qbaseSiwnCallback"
                  data-theme="dark"
                />
              </div>
            </>
          )}

          {state === 'ready' && !clientId && (
            <p className="connect-description">
              Configuration error: missing client ID. Please try again later.
            </p>
          )}

          {state === 'success' && (
            <div className="connect-success">
              ✅ Connected — you're all set to cast as yourself.
              <span className="connect-success-redirect">Redirecting to questions...</span>
            </div>
          )}

          {state === 'fid_mismatch' && (
            <div className="connect-warning">
              <div className="connect-warning-title">⚠️ Account mismatch</div>
              <p>
                You're signed into qbase as <strong>@{user?.username}</strong>
                {user?.fid ? ` (FID ${user.fid})` : ''}
                {' '}but you authenticated with Neynar as <strong>FID {connectedFid}</strong>.
              </p>
              <p>
                Switch your Farcaster client to <strong>@{user?.username}</strong> and try again.
              </p>
              <div className="connect-warning-actions">
                <button
                  className="connect-btn"
                  onClick={() => { setState('ready'); setRetryKey(k => k + 1); }}
                >
                  Try Again
                </button>
                <button className="connect-force-btn" onClick={handleForceConnect}>
                  Connect Anyway
                </button>
              </div>
            </div>
          )}

          {state === 'error' && (
            <div className="connect-error">
              {error}
              <br />
              <button
                className="connect-retry-btn"
                onClick={() => { setState('ready'); setError(null); setRetryKey(k => k + 1); }}
              >
                Try Again
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default ConnectPage;