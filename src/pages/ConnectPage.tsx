import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';

type State = 'need_auth' | 'loading' | 'ready' | 'success' | 'error';

const ConnectPage: React.FC = () => {
  const { isAuthenticated, getAuthToken, user } = useAuth();
  const [state, setState] = useState<State>('loading');
  const [error, setError] = useState<string | null>(null);

  // Check if we're returning from Neynar auth (has code param)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const signerUuid = params.get('signer_uuid');
    const fid = params.get('fid');

    if (signerUuid) {
      // Returning from Neynar auth — save the signer
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
          // Clean URL
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

    // Not returning from auth — check state
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
        if (approved) {
          setState('success');
        } else {
          setState('ready');
        }
      })
      .catch(() => setState('ready'));
  }, [isAuthenticated, getAuthToken]);

  const handleConnect = useCallback(async () => {
    try {
      // Fetch authorization URL from our server
      const token = getAuthToken();
      const headers = token ? { Authorization: `Bearer ${token}` } : {};
      const res = await fetch('/api/farcaster/signer/auth-url', { headers });
      const data = await res.json() as { authorization_url?: string; error?: string };

      if (!data.authorization_url) {
        setError(data.error || 'Failed to get authorization URL');
        setState('error');
        return;
      }

      // Redirect to Neynar auth page (full page navigation, not popup)
      window.location.href = data.authorization_url;
    } catch (e: any) {
      setError(e.message || 'Failed to start auth flow');
      setState('error');
    }
  }, [getAuthToken]);

  const btnStyle: React.CSSProperties = {
    background: '#8b5cf6',
    color: 'white',
    border: 'none',
    borderRadius: '16px',
    padding: '12px 32px',
    fontSize: '16px',
    fontWeight: 600,
    cursor: 'pointer',
    width: '100%',
  };

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#0f172a',
      color: 'white',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      padding: '20px',
    }}>
      <div style={{
        background: 'rgba(255,255,255,0.05)',
        borderRadius: '24px',
        padding: '40px',
        maxWidth: '400px',
        width: '100%',
        textAlign: 'center',
        backdropFilter: 'blur(8px)',
        border: '1px solid rgba(255,255,255,0.1)',
      }}>
        <div style={{ fontSize: '48px', marginBottom: '16px' }}>🔮</div>
        <h1 style={{
          fontSize: '24px', fontWeight: 600, marginBottom: '8px',
          color: 'rgba(255,255,255,0.9)',
        }}>
          Connect Farcaster
        </h1>

        {state === 'need_auth' && (
          <>
            <p style={{ fontSize: '14px', color: 'rgba(255,255,255,0.5)', marginBottom: '24px' }}>
              Sign in to qbase first, then connect your Farcaster account.
            </p>
            <a href="/" style={{ ...btnStyle, display: 'block', textDecoration: 'none', textAlign: 'center' }}>
              Go to qbase to sign in
            </a>
          </>
        )}

        {state === 'loading' && (
          <p style={{ fontSize: '14px', color: 'rgba(255,255,255,0.5)' }}>Loading...</p>
        )}

        {state === 'ready' && (
          <>
            <p style={{ fontSize: '14px', color: 'rgba(255,255,255,0.5)', marginBottom: '24px', lineHeight: 1.5 }}>
              Signed in as @{user?.username || 'user'}. Grant qbase permission to cast on your behalf.
            </p>
            <button onClick={handleConnect} style={btnStyle}>
              Connect Farcaster
            </button>
          </>
        )}

        {state === 'success' && (
          <div style={{
            background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.3)',
            borderRadius: '12px', padding: '16px', color: '#22c55e', fontSize: '14px',
          }}>
            ✅ Connected! Close this tab and return to qbase.
          </div>
        )}

        {state === 'error' && (
          <div style={{
            background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)',
            borderRadius: '12px', padding: '16px', color: '#ef4444', fontSize: '14px',
          }}>
            ❌ {error}
            <br />
            <button
              onClick={() => { setState('ready'); setError(null); }}
              style={{
                background: 'none', border: '1px solid rgba(239,68,68,0.5)',
                color: '#ef4444', borderRadius: '8px', padding: '8px 16px',
                marginTop: '12px', cursor: 'pointer', fontSize: '13px',
              }}
            >
              Try Again
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default ConnectPage;
