import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import Header from '../components/Header';

type State = 'need_auth' | 'loading' | 'ready' | 'connecting' | 'success' | 'error';

const NEYNAR_ORIGIN = 'https://app.neynar.com';

const ConnectPage: React.FC = () => {
  const { isAuthenticated, getAuthToken, user } = useAuth();
  const [state, setState] = useState<State>('loading');
  const [error, setError] = useState<string | null>(null);
  const popupRef = useRef<Window | null>(null);

  // Check if returning from Neynar redirect (signer_uuid in URL)
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

    const token = getAuthToken();
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    fetch('/api/farcaster/signer/list', { headers })
      .then(r => r.json())
      .then((data: any) => {
        setState((data.signers || []).some((s: any) => s.status === 'approved') ? 'success' : 'ready');
      })
      .catch(() => setState('ready'));
  }, [isAuthenticated, getAuthToken]);

  // Listen for postMessage from SIWN popup
  useEffect(() => {
    if (state !== 'connecting') return;

    const handleMessage = async (event: MessageEvent) => {
      if (event.origin !== NEYNAR_ORIGIN) return;
      if (!event.data?.is_authenticated) return;

      const { signer_uuid, fid } = event.data;
      if (!signer_uuid) return;

      if (popupRef.current && !popupRef.current.closed) popupRef.current.close();
      popupRef.current = null;

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
        setState(res.ok ? 'success' : 'error');
        if (!res.ok) setError('Failed to save signer');
      } catch (e: any) {
        setError(e.message || 'Network error');
        setState('error');
      }

      window.removeEventListener('message', handleMessage);
    };

    window.addEventListener('message', handleMessage);

    // Timeout after 2 minutes
    const timeout = setTimeout(() => {
      window.removeEventListener('message', handleMessage);
      if (popupRef.current && !popupRef.current.closed) popupRef.current.close();
      setState('ready');
      setError('Timed out waiting for approval');
    }, 120_000);

    return () => {
      window.removeEventListener('message', handleMessage);
      clearTimeout(timeout);
    };
  }, [state, getAuthToken]);

  const handleConnect = useCallback(async () => {
    // Open popup synchronously (preserves user gesture for Safari mobile)
    const popup = window.open('about:blank', 'neynar_auth', 'width=500,height=700');
    if (!popup) {
      setError('Popup blocked. Please allow popups for this site and try again.');
      setState('error');
      return;
    }
    popupRef.current = popup;
    setState('connecting');

    // Write a loading message to the popup
    popup.document.write('<html><body style="background:#0f172a;color:white;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><p>Loading...</p></body></html>');

    try {
      const token = getAuthToken();
      const headers = token ? { Authorization: `Bearer ${token}` } : {};
      const res = await fetch('/api/farcaster/signer/auth-url', { headers });
      const data = await res.json() as { authorization_url?: string; error?: string };

      if (!data.authorization_url) {
        popup.close();
        setError(data.error || 'Failed to get authorization URL');
        setState('error');
        return;
      }

      // Navigate the popup to the Neynar auth URL
      popup.location.href = data.authorization_url;
    } catch (e: any) {
      popup.close();
      setError(e.message || 'Failed to start auth flow');
      setState('error');
    }
  }, [getAuthToken]);

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

          {state === 'ready' && (
            <>
              <p style={pStyle}>
                Signed in as <strong style={{ color: 'rgba(255,255,255,0.7)' }}>@{user?.username || 'user'}</strong>.
                Grant qbase permission to cast on your behalf.
              </p>
              <button onClick={handleConnect} style={btnStyle}>Connect Farcaster</button>
            </>
          )}

          {state === 'connecting' && (
            <>
              <p style={pStyle}>Complete sign-in in the popup window...</p>
              <div style={{ color: '#fbbf24', fontSize: '13px' }}>⏳ Waiting for approval</div>
            </>
          )}

          {state === 'success' && (
            <div style={successBox}>✅ Connected! Close this tab and return to qbase.</div>
          )}

          {state === 'error' && (
            <div style={errorBox}>
              {error}
              <br />
              <button onClick={() => { setState('ready'); setError(null); }} style={retryBtn}>Try Again</button>
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
