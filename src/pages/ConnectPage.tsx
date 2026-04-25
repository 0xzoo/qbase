import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import Header from '../components/Header';

type State = 'need_auth' | 'loading' | 'ready' | 'success' | 'error';

const ConnectPage: React.FC = () => {
  const { isAuthenticated, getAuthToken, user } = useAuth();
  const [state, setState] = useState<State>('loading');
  const [error, setError] = useState<string | null>(null);

  // Check if returning from Neynar auth (signer_uuid in URL)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const signerUuid = params.get('signer_uuid');
    const fid = params.get('fid');

    if (signerUuid) {
      setState('loading');
      const token = getAuthToken();
      fetch('/api/farcaster/signer/save', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ signer_uuid: signerUuid, fid: fid ? parseInt(fid) : undefined }),
      }).then(res => {
        if (res.ok) {
          setState('success');
          window.history.replaceState({}, '', '/connect');
        } else {
          setError('Failed to save signer');
          setState('error');
        }
      }).catch(() => {
        setError('Network error');
        setState('error');
      });
      return;
    }

    if (!isAuthenticated) {
      setState('need_auth');
      return;
    }

    // Check if already connected
    const token = getAuthToken();
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    fetch('/api/farcaster/signer/list', { headers })
      .then(r => r.json())
      .then((data: any) => {
        const approved = (data.signers || []).some((s: any) => s.status === 'approved');
        setState(approved ? 'success' : 'ready');
      })
      .catch(() => setState('ready'));
  }, [isAuthenticated, getAuthToken]);

  const handleConnect = useCallback(async () => {
    try {
      const token = getAuthToken();
      const headers = token ? { Authorization: `Bearer ${token}` } : {};
      const res = await fetch('/api/farcaster/signer/auth-url', { headers });
      const data = await res.json() as { authorization_url?: string; error?: string };

      if (!data.authorization_url) {
        setError(data.error || 'Failed to get authorization URL');
        setState('error');
        return;
      }

      // Full page redirect to Neynar auth
      window.location.href = data.authorization_url;
    } catch (e: any) {
      setError(e.message || 'Failed to start auth flow');
      setState('error');
    }
  }, [getAuthToken]);

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-primary, #0f172a)' }}>
      <Header />
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '40px 20px',
        minHeight: 'calc(100vh - 60px)',
      }}>
        <div style={{
          background: 'rgba(255,255,255,0.03)',
          borderRadius: '24px',
          padding: '40px',
          maxWidth: '420px',
          width: '100%',
          textAlign: 'center',
          border: '1px solid rgba(255,255,255,0.06)',
        }}>
          <div style={{ fontSize: '48px', marginBottom: '16px' }}>🔮</div>
          <h1 style={{
            fontFamily: 'var(--font-display)',
            fontSize: '22px',
            fontWeight: 600,
            marginBottom: '8px',
            color: 'rgba(255,255,255,0.9)',
          }}>
            Connect Farcaster
          </h1>

          {state === 'need_auth' && (
            <>
              <p style={{
                fontFamily: 'var(--font-body)',
                fontSize: '14px',
                color: 'rgba(255,255,255,0.45)',
                marginBottom: '24px',
                lineHeight: 1.5,
              }}>
                Sign in to qbase first, then connect your Farcaster account for write access.
              </p>
              <a
                href="/"
                style={{
                  display: 'inline-block',
                  background: '#007AFF',
                  color: 'white',
                  borderRadius: '20px',
                  padding: '12px 32px',
                  fontSize: '15px',
                  fontWeight: 600,
                  fontFamily: 'var(--font-display)',
                  textDecoration: 'none',
                  boxShadow: '0 4px 12px rgba(0, 122, 255, 0.25)',
                }}
              >
                Sign in to qbase
              </a>
            </>
          )}

          {state === 'loading' && (
            <p style={{
              fontFamily: 'var(--font-body)',
              fontSize: '14px',
              color: 'rgba(255,255,255,0.45)',
            }}>
              Loading...
            </p>
          )}

          {state === 'ready' && (
            <>
              <p style={{
                fontFamily: 'var(--font-body)',
                fontSize: '14px',
                color: 'rgba(255,255,255,0.45)',
                marginBottom: '24px',
                lineHeight: 1.5,
              }}>
                Signed in as <strong style={{ color: 'rgba(255,255,255,0.7)' }}>@{user?.username || 'user'}</strong>.
                Grant qbase permission to cast on your behalf.
              </p>
              <button
                onClick={handleConnect}
                style={{
                  background: '#007AFF',
                  color: 'white',
                  border: 'none',
                  borderRadius: '20px',
                  padding: '12px 32px',
                  fontSize: '15px',
                  fontWeight: 600,
                  fontFamily: 'var(--font-display)',
                  cursor: 'pointer',
                  boxShadow: '0 4px 12px rgba(0, 122, 255, 0.25)',
                }}
              >
                Connect Farcaster
              </button>
            </>
          )}

          {state === 'success' && (
            <div style={{
              background: 'rgba(34,197,94,0.08)',
              border: '1px solid rgba(34,197,94,0.2)',
              borderRadius: '16px',
              padding: '20px',
              color: '#22c55e',
              fontSize: '14px',
              fontFamily: 'var(--font-body)',
            }}>
              ✅ Connected! You can close this tab and return to qbase.
            </div>
          )}

          {state === 'error' && (
            <div style={{
              background: 'rgba(239,68,68,0.08)',
              border: '1px solid rgba(239,68,68,0.2)',
              borderRadius: '16px',
              padding: '20px',
              color: '#ef4444',
              fontSize: '14px',
              fontFamily: 'var(--font-body)',
            }}>
              {error}
              <br />
              <button
                onClick={() => { setState('ready'); setError(null); }}
                style={{
                  background: 'none',
                  border: '1px solid rgba(239,68,68,0.4)',
                  color: '#ef4444',
                  borderRadius: '12px',
                  padding: '8px 20px',
                  marginTop: '16px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  fontFamily: 'var(--font-body)',
                }}
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
