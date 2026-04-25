import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import Header from '../components/Header';

type State = 'need_auth' | 'loading' | 'ready' | 'connecting' | 'success' | 'error';

/**
 * ConnectPage — Farcaster signer connection via Neynar SIWN.
 *
 * Uses Neynar's official SIWN script (<div class="neynar_signin">) instead of
 * a manual popup + postMessage listener. The script handles popup lifecycle,
 * cross-origin messaging, and the "Continue with Qbase" button reliably.
 *
 * Fallback: also handles ?signer_uuid=...&fid=... in URL params for redirect returns.
 */
const ConnectPage: React.FC = () => {
  const { isAuthenticated, getAuthToken, user } = useAuth();
  const [state, setState] = useState<State>('loading');
  const [error, setError] = useState<string | null>(null);
  const [clientId, setClientId] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const siwnDivRef = React.useRef<HTMLDivElement>(null);

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
        setState(res.ok ? 'success' : 'error');
        if (res.ok) window.history.replaceState({}, '', '/connect');
        else setError('Failed to save signer');
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

  // ── SIWN success callback (called by Neynar's script via postMessage) ──
  const onSignInSuccess = useCallback(async (data: { signer_uuid: string; fid: number; is_authenticated?: boolean }) => {
    if (!data?.signer_uuid) return;

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
  }, [getAuthToken]);

  // ── Expose callback globally for Neynar SIWN script ──
  useEffect(() => {
    (window as any).__qbaseSiwnCallback = onSignInSuccess;
    return () => { delete (window as any).__qbaseSiwnCallback; };
  }, [onSignInSuccess]);

  // ── Load Neynar SIWN script ──
  useEffect(() => {
    if (state !== 'ready' || !clientId) return;

    // Avoid double-loading
    if (document.querySelector('script[src*="neynarxyz.github.io/siwn"]')) return;

    const script = document.createElement('script');
    script.src = 'https://neynarxyz.github.io/siwn/raw/1.2.0/index.js';
    script.async = true;
    document.body.appendChild(script);

    return () => {
      // Keep script loaded — it's harmless and prevents re-init issues
    };
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
                Grant qbase permission to cast on your behalf.
              </p>
              <div
                ref={siwnDivRef}
                key={`siwn-${retryKey}`}
                className="neynar_signin"
                data-client_id={clientId}
                data-success-callback="__qbaseSiwnCallback"
                data-theme="dark"
              />
            </>
          )}

          {state === 'ready' && !clientId && (
            <p style={pStyle}>Configuration error: missing client ID. Please try again later.</p>
          )}

          {state === 'connecting' && (
            <p style={pStyle}>Complete sign-in in the popup window...</p>
          )}

          {state === 'success' && (
            <div style={successBox}>✅ Connected! Close this tab and return to qbase.</div>
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

export default ConnectPage;
