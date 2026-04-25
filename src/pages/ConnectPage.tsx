import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import Header from '../components/Header';

type State = 'need_auth' | 'loading' | 'ready' | 'success' | 'fid_mismatch' | 'error';

/**
 * ConnectPage — Farcaster signer connection via Neynar SIWN.
 *
 * Uses Neynar's official SIWN script (<div class="neynar_signin">) to handle
 * popup lifecycle, cross-origin messaging, and the callback reliably.
 *
 * Also handles FID mismatch: if the user authenticates via SIWN as a different
 * Farcaster account than their qbase account, we warn them instead of saving
 * the wrong signer.
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

  // ── Check for returning from Neynar redirect (signer_uuid in URL) ──
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
        body: JSON.stringify({ signer_uuid: signerUuid, fid: params.get('fid') ? parseInt(params.get('fid')!) : undefined }),
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

    // Load client_id AND check existing signers
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
      redirectTimerRef.current = setTimeout(() => {
        navigate('/questions');
      }, 2000);
    }
    return () => {
      if (redirectTimerRef.current) clearTimeout(redirectTimerRef.current);
    };
  }, [state, navigate]);

  // ── SIWN success callback ──
  const onSignInSuccess = useCallback(async (data: { signer_uuid: string; fid: number; is_authenticated?: boolean }) => {
    if (!data?.signer_uuid) return;

    // FID mismatch check: if user has a Farcaster FID on their qbase account,
    // make sure the SIWN auth used the same account
    if (user?.fid && data.fid && user.fid !== data.fid) {
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

  // ── Force-save despite FID mismatch (user confirms they want this) ──
  const handleForceConnect = useCallback(async () => {
    setState('loading');
    try {
      // Re-trigger SIWN — but this time we'll save regardless.
      // Actually, we don't have the signer data anymore. So we just retry.
      setRetryKey(k => k + 1);
      // Temporarily override: set a flag so the next callback skips FID check
      (window as any).__qbaseSkipFidCheck = true;
      setState('ready');
    } catch (e: any) {
      setError(e.message || 'Failed');
      setState('error');
    }
  }, []);

  // Override the callback to support skip-fid-check mode
  const onSignInSuccessWithOverride = useCallback(async (data: { signer_uuid: string; fid: number; is_authenticated?: boolean }) => {
    if (!data?.signer_uuid) return;

    const skipFidCheck = (window as any).__qbaseSkipFidCheck;
    delete (window as any).__qbaseSkipFidCheck;

    // FID mismatch check (unless overridden)
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

  // ── Expose callback globally for Neynar SIWN script ──
  useEffect(() => {
    (window as any).__qbaseSiwnCallback = onSignInSuccessWithOverride;
    return () => { delete (window as any).__qbaseSiwnCallback; };
  }, [onSignInSuccessWithOverride]);

  // ── Load Neynar SIWN script ──
  useEffect(() => {
    if (state !== 'ready' || !clientId) return;

    // Avoid double-loading
    if (document.querySelector('script[src*="neynarxyz.github.io/siwn"]')) return;

    const script = document.createElement('script');
    script.src = 'https://neynarxyz.github.io/siwn/raw/1.2.0/index.js';
    script.async = true;
    document.body.appendChild(script);
  }, [state, clientId]);

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-primary, #0f172a)' }}>
      <Header />
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '40px 20px', minHeight: 'calc(100vh - 60px)',
      }}>
        <div style={{
          background: 'rgba(255,255,255,0.03)', borderRadius: '24px',
          padding: '40px', maxWidth: '420px', width: '100%', textAlign: 'center',
          border: '1px solid rgba(255,255,255,0.06)',
        }}>
          <div style={{ fontSize: '48px', marginBottom: '16px' }}>🔮</div>
          <h1 style={{
            fontFamily: 'var(--font-display)', fontSize: '22px', fontWeight: 600,
            marginBottom: '8px', color: 'rgba(255,255,255,0.9)',
          }}>Connect Farcaster</h1>

          {state === 'need_auth' && (
            <>
              <p style={pStyle}>Sign in to qbase first, then connect your Farcaster account.</p>
              <a href="/" style={btnStyle}>Sign in to qbase</a>
            </>
          )}

          {state === 'loading' && <p style={pStyle}>Loading...</p>}

          {state === 'ready' && clientId && (
            <>
              <p style={pStyle}>
                Signed in as <strong style={{ color: 'rgba(255,255,255,0.7)' }}>@{user?.username || 'user'}</strong>.
                {' '}Make sure you sign in as the same Farcaster account.
              </p>
              <div style={{ display: 'flex', justifyContent: 'center' }}>
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
            <p style={pStyle}>Configuration error: missing client ID. Please try again later.</p>
          )}

          {state === 'success' && (
            <div style={successBox}>
              ✅ Connected — you're all set to cast as yourself.
              <br />
              <span style={{ fontSize: '12px', opacity: 0.7, marginTop: '8px', display: 'block' }}>
                Redirecting to questions...
              </span>
            </div>
          )}

          {state === 'fid_mismatch' && (
            <div style={warningBox}>
              <div style={{ fontWeight: 600, marginBottom: '8px' }}>⚠️ Account mismatch</div>
              <p style={{ margin: '0 0 8px', fontSize: '13px', lineHeight: 1.5 }}>
                You're signed into qbase as <strong>@{user?.username}</strong>{user?.fid ? ` (FID ${user.fid})` : ''}
                {' '}but you authenticated with Neynar as <strong>FID {connectedFid}</strong>.
              </p>
              <p style={{ margin: '0 0 16px', fontSize: '13px', lineHeight: 1.5 }}>
                Casts would go to the wrong account. Switch your Farcaster client to
                {' '}<strong>@{user?.username}</strong> and try again.
              </p>
              <div style={{ display: 'flex', gap: '8px', justifyContent: 'center' }}>
                <button onClick={() => { setState('ready'); setRetryKey(k => k + 1); }} style={btnStyle}>
                  Try Again
                </button>
                <button onClick={handleForceConnect} style={forceBtn}>
                  Connect Anyway
                </button>
              </div>
            </div>
          )}

          {state === 'error' && (
            <div style={errorBox}>
              {error}
              <br />
              <button onClick={() => { setState('ready'); setError(null); setRetryKey(k => k + 1); }} style={retryBtn}>Try Again</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

const pStyle: React.CSSProperties = {
  fontFamily: 'var(--font-body)', fontSize: '14px',
  color: 'rgba(255,255,255,0.45)', marginBottom: '24px', lineHeight: 1.5,
};

const btnStyle: React.CSSProperties = {
  display: 'inline-block', background: '#007AFF', color: 'white',
  borderRadius: '20px', padding: '12px 32px', fontSize: '15px',
  fontWeight: 600, fontFamily: 'var(--font-display)', textDecoration: 'none',
  border: 'none', cursor: 'pointer', boxShadow: '0 4px 12px rgba(0,122,255,0.25)',
};

const successBox: React.CSSProperties = {
  background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.2)',
  borderRadius: '16px', padding: '20px', color: '#22c55e', fontSize: '14px',
  fontFamily: 'var(--font-body)',
};

const warningBox: React.CSSProperties = {
  background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.2)',
  borderRadius: '16px', padding: '20px', color: '#fbbf24', fontSize: '14px',
  fontFamily: 'var(--font-body)', textAlign: 'left',
};

const errorBox: React.CSSProperties = {
  background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)',
  borderRadius: '16px', padding: '20px', color: '#ef4444', fontSize: '14px',
  fontFamily: 'var(--font-body)',
};

const retryBtn: React.CSSProperties = {
  background: 'none', border: '1px solid rgba(239,68,68,0.4)',
  color: '#ef4444', borderRadius: '12px', padding: '8px 20px',
  marginTop: '16px', cursor: 'pointer', fontSize: '13px',
  fontFamily: 'var(--font-body)',
};

const forceBtn: React.CSSProperties = {
  background: 'none', border: '1px solid rgba(251,191,36,0.4)',
  color: '#fbbf24', borderRadius: '20px', padding: '12px 24px', fontSize: '14px',
  fontWeight: 500, fontFamily: 'var(--font-display)', cursor: 'pointer',
};

export default ConnectPage;
