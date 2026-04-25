import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';

const SIWN_SCRIPT_URL = 'https://neynarxyz.github.io/siwn/raw/1.2.0/index.js';
const SIWN_CALLBACK = '__qbase_connect_callback';

type State = 'need_auth' | 'loading' | 'ready' | 'connecting' | 'success' | 'error';

const ConnectPage: React.FC = () => {
  const { isAuthenticated, getAuthToken, user } = useAuth();
  const [state, setState] = useState<State>('loading');
  const [clientId, setClientId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Check auth + fetch client ID
  useEffect(() => {
    if (!isAuthenticated) {
      setState('need_auth');
      return;
    }

    fetch('/api/farcaster/signer/siwn-config')
      .then(r => r.json())
      .then((data: any) => {
        setClientId(data.client_id || null);
        setState('ready');
      })
      .catch(() => {
        setError('Failed to load configuration');
        setState('error');
      });
  }, [isAuthenticated]);

  // Load SIWN script
  useEffect(() => {
    if (!clientId) return;
    if (document.querySelector(`script[src="${SIWN_SCRIPT_URL}"]`)) return;
    const s = document.createElement('script');
    s.src = SIWN_SCRIPT_URL;
    s.async = true;
    document.head.appendChild(s);
  }, [clientId]);

  // Register SIWN callback
  useEffect(() => {
    (window as any)[SIWN_CALLBACK] = async (data: any) => {
      console.log('[Connect] SIWN success:', data);
      const { signer_uuid, fid } = data;
      if (!signer_uuid) {
        setError('No signer returned from Neynar');
        setState('error');
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
          body: JSON.stringify({ signer_uuid, fid }),
        });

        if (res.ok) {
          setState('success');
        } else {
          const errData = await res.json().catch(() => ({}));
          setError((errData as any).error || 'Failed to save signer');
          setState('error');
        }
      } catch (e: any) {
        setError(e.message || 'Network error');
        setState('error');
      }
    };
    return () => { delete (window as any)[SIWN_CALLBACK]; };
  }, [getAuthToken]);

  const handleConnect = useCallback(() => {
    setState('connecting');
    setTimeout(() => {
      const btn = document.querySelector('#siwn-button') as HTMLButtonElement;
      if (btn) {
        btn.click();
      } else {
        setError('SIWN button not ready. Please refresh and try again.');
        setState('error');
      }
    }, 200);
  }, []);

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

        {/* Need auth */}
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

        {/* Loading */}
        {state === 'loading' && (
          <p style={{ fontSize: '14px', color: 'rgba(255,255,255,0.5)' }}>Loading...</p>
        )}

        {/* Ready to connect */}
        {(state === 'ready' || state === 'connecting') && (
          <>
            <p style={{ fontSize: '14px', color: 'rgba(255,255,255,0.5)', marginBottom: '24px', lineHeight: 1.5 }}>
              {state === 'connecting'
                ? 'Complete sign-in in the popup window...'
                : `Signed in as @${user?.username || 'user'}. Grant qbase permission to cast on your behalf.`}
            </p>

            {/* Hidden SIWN widget */}
            {clientId && (
              <div style={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden' }}>
                <div
                  className="neynar_signin"
                  data-client_id={clientId}
                  data-success_callback={SIWN_CALLBACK}
                  data-theme="dark"
                  data-variant="farcaster"
                />
              </div>
            )}

            {state === 'ready' && (
              <button onClick={handleConnect} style={btnStyle}>
                Connect Farcaster
              </button>
            )}
            {state === 'connecting' && (
              <div style={{ color: '#fbbf24', fontSize: '14px' }}>⏳ Waiting for approval...</div>
            )}
          </>
        )}

        {/* Success */}
        {state === 'success' && (
          <div style={{
            background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.3)',
            borderRadius: '12px', padding: '16px', color: '#22c55e', fontSize: '14px',
          }}>
            ✅ Connected! Close this tab and return to qbase.
          </div>
        )}

        {/* Error */}
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
