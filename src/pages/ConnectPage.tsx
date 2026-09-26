import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { FARCASTER_REQUIRED_MESSAGE, isFarcasterRequired } from '../lib/farcasterRequired';
import Header from '../components/Header';
import './ConnectPage.css';

type State = 'loading' | 'ready' | 'connecting' | 'success' | 'fid_mismatch' | 'error';

/**
 * POST /api/farcaster/signer/connect, retrying on HTTP 425.
 *
 * The server verifies the signer with Neynar and derives the FID from the approved
 * signer's owner (it does not trust a client-supplied FID). A freshly-approved signer
 * can briefly lag in Neynar's read API, in which case the server returns 425
 * { retryable: true } rather than minting an unverified session — so we re-POST the
 * same signer_uuid a few times before surfacing an error, instead of forcing a full
 * SIWN re-authentication. Throws on terminal failure (caller shows the error state).
 */
async function connectWithRetry(
  signerUuid: string,
  fid: number,
  maxAttempts = 3,
): Promise<{ token: string; fid: number }> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const res = await fetch('/api/farcaster/signer/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signer_uuid: signerUuid, fid }),
    });
    if (res.ok) {
      return await res.json() as { token: string; fid: number };
    }
    // 425 = signer not yet approved on Neynar's side; back off and retry.
    if (res.status === 425 && attempt < maxAttempts - 1) {
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      continue;
    }
    const errBody = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(errBody.error || 'Failed to connect');
  }
  // Exhausted retries while still 425.
  throw new Error('Signer not yet approved — please try again');
}

/**
 * ConnectPage — Farcaster signer connection via Neynar SIWN.
 *
 * Single-step flow: Neynar SIWN handles both authentication and signer creation.
 * If already logged into qbase, the existing session is used to save the signer.
 * If not, the SIWN callback creates a qbase session AND saves the signer in one go.
 */
const ConnectPage: React.FC = () => {
  const { isAuthenticated, getAuthToken, user, fid: farcasterFid } = useAuth();
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

  // ── Initialization: redirect return, or check for approved signer ──
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const signerUuid = params.get('signer_uuid');
    if (signerUuid) {
      setState('loading');
      const fidParam = params.get('fid') ? parseInt(params.get('fid')!) : undefined;
      const token = getAuthToken();
      if (token) {
        // Already authenticated — save via /save (needs auth header)
        fetch('/api/farcaster/signer/save', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ signer_uuid: signerUuid, fid: fidParam }),
        }).then(async res => {
          if (res.ok) {
            window.history.replaceState({}, '', '/connect');
            setState('success');
          } else {
            setError(await isFarcasterRequired(res) ? FARCASTER_REQUIRED_MESSAGE : 'Failed to save signer');
            setState('error');
          }
        }).catch(() => { setError('Network error'); setState('error'); });
      } else if (fidParam) {
        // Not authenticated — use /connect (no auth needed, creates session)
        connectWithRetry(signerUuid, fidParam).then(async body => {
          // Fetch profile from backend to get real username/pfp
          let username = String(body.fid);
          let pfpUrl: string | undefined;
          let displayName: string | undefined;
          try {
            const profileRes = await fetch('/api/users/me', {
              headers: { Authorization: `Bearer ${body.token}` },
            });
            if (profileRes.ok) {
              const profile = await profileRes.json() as any;
              username = profile.username || profile.fname || username;
              pfpUrl = profile.pfp_url || profile.pfpUrl || undefined;
              displayName = profile.display_name || profile.displayName || undefined;
            }
          } catch { /* use defaults */ }
          localStorage.setItem('fc_user', JSON.stringify({
            fid: body.fid,
            sessionToken: body.token,
            username,
            pfpUrl,
            displayName,
          }));
          window.location.href = '/connect';
        }).catch((e: any) => { setError(e.message || 'Network error'); setState('error'); });
      } else {
        setError('Missing signer data');
        setState('error');
      }
      return;
    }

    // Fetch SIWN config (no auth needed)
    fetch('/api/farcaster/signer/siwn-config')
      .then(r => r.json())
      .then(config => {
        setClientId(config.client_id || null);
      })
      .catch(() => setClientId(null));

    // If authenticated, check for existing approved signer
    if (isAuthenticated) {
      const token = getAuthToken();
      const headers = token ? { Authorization: `Bearer ${token}` } : {};
      fetch('/api/farcaster/signer/list', { headers })
        .then(r => r.json())
        .then((listData: any) => {
          const approved = (listData.signers || []).some((s: any) => s.status === 'approved');
          setState(approved ? 'success' : 'ready');
        })
        .catch(() => setState('ready'));
    } else {
      // Not authenticated — go straight to SIWN widget (it handles both auth + signer)
      setState('ready');
    }
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
  // Neynar SIWN callback includes { signer_uuid, fid, user: { username, pfp, display_name } }
  const onSignInSuccess = useCallback(async (
    data: { signer_uuid: string; fid: number; user?: { username?: string; pfp?: string; display_name?: string } }
  ) => {
    if (!data?.signer_uuid) return;

    const skipFidCheck = (window as any).__qbaseSkipFidCheck;
    delete (window as any).__qbaseSkipFidCheck;

    // FID mismatch check (only when already logged in)
    // Use Number() to absorb type differences (Neynar SIWN may return
    // fid as a string while user.fid is a number from Quick Auth).
    if (!skipFidCheck && isAuthenticated && farcasterFid && data.fid && Number(farcasterFid) !== Number(data.fid)) {
      setConnectedFid(data.fid);
      setState('fid_mismatch');
      return;
    }

    setState('connecting');

    try {
      if (isAuthenticated) {
        // Already logged in — just save the signer
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
        if (!res.ok) setError(await isFarcasterRequired(res) ? FARCASTER_REQUIRED_MESSAGE : 'Failed to save signer');
      } else {
        // Not logged in — connect creates both auth session + signer.
        // connectWithRetry retries on 425 (signer not yet approved on Neynar's side)
        // and throws on terminal failure; the surrounding try/catch shows the error.
        const body = await connectWithRetry(data.signer_uuid, data.fid);
        // Store session so AuthContext picks it up on reload.
        // Use username/pfp from the SIWN callback if available (Neynar already has it).
        localStorage.setItem('fc_user', JSON.stringify({
          fid: body.fid,
          sessionToken: body.token,
          username: data.user?.username || String(body.fid),
          pfpUrl: data.user?.pfp || undefined,
          displayName: data.user?.display_name || undefined,
        }));
        window.location.reload();
      }
    } catch (e: any) {
      setError(e.message || 'Network error');
      setState('error');
    }
  }, [isAuthenticated, getAuthToken, farcasterFid]);

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

    // Remove any stale SIWN scripts (retry, re-render, etc.)
    document.querySelectorAll('script[src*="neynarxyz.github.io/siwn"]').forEach(el => el.remove());

    const script = document.createElement('script');
    script.src = 'https://neynarxyz.github.io/siwn/raw/1.2.0/index.js';
    script.async = true;
    document.body.appendChild(script);
  }, [state, clientId, retryKey]);

  return (
    <div className="connect-page">
      <Header />
      <div className="connect-container">
        <div className="connect-card">
          <div className="connect-icon">
            <img src="/qbase.svg" alt="qbase" className="connect-logo" />
          </div>
          <h1 className="connect-title">Connect Farcaster</h1>

          {state === 'loading' && (
            <p className="connect-loading">Loading...</p>
          )}

          {state === 'ready' && clientId && (
            <>
              <p className="connect-description">
                {isAuthenticated
                  ? <>Signed in as <strong>@{user?.username || 'user'}</strong>.{' '}
                    Make sure you sign in as the same Farcaster account.</>
                  : <>Sign in with Neynar to connect your Farcaster account and start casting.</>
                }
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

          {state === 'connecting' && (
            <p className="connect-loading">Connecting your signer...</p>
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
                {farcasterFid ? ` (FID ${farcasterFid})` : ''}
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
