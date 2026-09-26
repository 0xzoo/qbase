/**
 * PasskeySignInModal
 *
 * Custom sign-in modal using native WebAuthn + @noble/curves Ed448.
 * No SDK dependency — fully self-contained.
 *
 * States: idle -> authenticating | registering -> success -> close
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { SignInButton, type StatusAPIResponse } from '@farcaster/auth-kit';
import { fetchAuthNonce } from '../context/auth/fetchAuthNonce';
import { register, discover, getCurrentPasskey, signLoginChallenge } from '../crypto/passkey';
import './PasskeySignInModal.css';

type ModalState = 'idle' | 'authenticating' | 'farcaster' | 'registering' | 'success' | 'error';

interface LoginResponse {
  sessionToken?: string;
  fid?: number | null;
  displayName?: string;
  fname?: string;
  pfpUrl?: string | null;
  error?: string;
}

/**
 * Issue a login attempt against the Ed448-challenge backend. Returns the
 * resolved address (so the caller can plumb it back into AuthContext) plus
 * the parsed login response. Throws if any step fails.
 */
async function performPasskeyLogin(opts: { address?: string; credentialId?: string }): Promise<{ address: string; data: LoginResponse }> {
  const params = new URLSearchParams();
  if (opts.address) params.set('address', opts.address);
  else if (opts.credentialId) params.set('credentialId', opts.credentialId);
  else throw new Error('address or credentialId required');

  const challengeRes = await fetch(`/api/auth/passkey/challenge?${params.toString()}`);
  if (!challengeRes.ok) {
    throw new Error(`Failed to obtain challenge (${challengeRes.status})`);
  }
  const { address, challenge } = (await challengeRes.json()) as { address: string; challenge: string };

  // Sign locally — requires Ed448 private key in localStorage for this address.
  // If absent (e.g., discoverable credential on a fresh browser), this throws.
  const signature = await signLoginChallenge(address, challenge);

  const loginRes = await fetch('/api/auth/passkey/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, signature }),
  });
  const data = (await loginRes.json()) as LoginResponse;
  return { address, data };
}

/**
 * WebAuthn Signal API (Chrome 132+, Safari 26+): tell the platform a
 * credential is unknown to qbase's usable set so it stops being offered.
 * Best effort; a no-op where unsupported.
 */
function forgetStalePasskey(credentialId: string | null) {
  if (!credentialId) return;
  const pkc = (window as unknown as { PublicKeyCredential?: { signalUnknownCredential?: (o: { rpId: string; credentialId: string }) => Promise<void> } }).PublicKeyCredential;
  pkc?.signalUnknownCredential?.({ rpId: window.location.hostname, credentialId }).catch(() => {});
}

export function PasskeySignInModal() {
  const {
    showPasskeyModal,
    handlePasskeyAuth,
    handleWebAuth,
    closePasskeyModal,
    user,
    accountMethods,
    accountAuthBusy,
    accountAuthError,
    loginWithEthereum,
    loginWithWorld,
  } = useAuth();

  const [state, setState] = useState<ModalState>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const loginAttemptedRef = useRef(false);

  // Check for existing stored passkey
  const currentPasskey = showPasskeyModal ? getCurrentPasskey() : null;

  // Reset state when modal opens — or skip to registration if already authenticated
  useEffect(() => {
    if (showPasskeyModal) {
      setErrorMessage('');
      loginAttemptedRef.current = false;
      // Already signed in via Farcaster or passkey → offer to create/link passkey
      if (user?.sessionToken) {
        const existingPasskey = getCurrentPasskey();
        if (existingPasskey) {
          // Has a local passkey but may not be linked to current account — try linking
          setState('registering');
          (async () => {
            try {
              const res = await fetch('/api/auth/passkey/register', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${user.sessionToken}`,
                },
                body: JSON.stringify({
                  address: existingPasskey.address,
                  publicKey: existingPasskey.publicKey,
                  credentialId: existingPasskey.credentialId,
                  displayName: existingPasskey.displayName,
                  fid: user?.fid,
                  linkToExisting: true,
                  registrationData: {
                    credentialId: existingPasskey.credentialId,
                    publicKey: existingPasskey.publicKey,
                    user_public_key: existingPasskey.publicKey,
                  },
                }),
              });
              if (res.ok) {
                setState('success');
                setTimeout(() => closePasskeyModal(), 800);
              } else {
                setState('error');
                setErrorMessage('Failed to link existing passkey to your account.');
              }
            } catch (err: any) {
              console.error('[PasskeySignIn] Link existing passkey error:', err);
              setState('error');
              setErrorMessage('Could not link passkey. Please try again.');
            }
          })();
          return;
        }

        // No local passkey — stay idle so user can click "Create Passkey"
        setState('idle');
      } else {
        setState('idle');
      }
    }
  }, [showPasskeyModal, user?.sessionToken, user?.fid]);

  // Auto-login for returning users (passkey already in localStorage)
  useEffect(() => {
    if (!showPasskeyModal || loginAttemptedRef.current) return;
    if (!currentPasskey?.address) return;
    // Don't auto-login if already authenticated — user is adding a passkey, not signing in
    if (user?.sessionToken) return;

    // Already authenticated?
    if (user?.passkeyAddress === currentPasskey.address && user?.sessionToken) {
      closePasskeyModal();
      return;
    }

    loginAttemptedRef.current = true;
    setState('authenticating');

    const { address, displayName } = currentPasskey;

    (async () => {
      try {
        // signLoginChallenge runs the WebAuthn ceremony itself (biometric +
        // PRF eval to unwrap the Ed448 key), so no separate authenticate()
        // call is needed here.
        const { data } = await performPasskeyLogin({ address });

        if (data.sessionToken) {
          localStorage.setItem('passkey_session_token', data.sessionToken);
          setState('success');
          setTimeout(() => {
            handlePasskeyAuth(address, data.sessionToken!, data.fid, data.fname || data.displayName || displayName, data.pfpUrl);
            closePasskeyModal();
          }, 600);
        } else {
          setState('error');
          setErrorMessage(data.error || 'Sign-in failed. Try creating a new passkey.');
        }
      } catch (err: any) {
        console.error('[PasskeySignIn] Auto-login error:', err);
        if (err?.name === 'NotAllowedError') {
          setState('idle');
        } else {
          setState('error');
          setErrorMessage('Failed to sign in. Please try again.');
        }
      }
    })();
  }, [showPasskeyModal, currentPasskey?.address, currentPasskey?.credentialId, currentPasskey?.displayName, user?.passkeyAddress, user?.sessionToken, handlePasskeyAuth, closePasskeyModal]);

  // "Create Passkey" path — registers a new WebAuthn credential + Ed448 keypair
  // If user has an existing FC session, links the passkey to that account (/link endpoint)
  // Otherwise creates a new passkey-only account (/register endpoint)
  const handleRegister = useCallback(async () => {
    setState('registering');
    try {
      const result = await register(user?.username || user?.displayName);
      const { passkey } = result;

      // Determine endpoint: link to existing FC session, or register new account
      const isLinkingToFC = !!user?.sessionToken;
      const endpoint = isLinkingToFC ? '/api/auth/passkey/link' : '/api/auth/passkey/register';
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (isLinkingToFC && user?.sessionToken) {
        headers['Authorization'] = `Bearer ${user.sessionToken}`;
      }

      const payload: Record<string, unknown> = {
        address: passkey.address,
        publicKey: passkey.publicKey,
        credentialId: passkey.credentialId,
        displayName: passkey.displayName,
        registrationData: {
          credentialId: passkey.credentialId,
          publicKey: passkey.publicKey,
          user_public_key: passkey.publicKey,
        },
      };
      // Include FID when linking to an existing FC account
      if (isLinkingToFC && user?.fid) {
        (payload as Record<string, unknown>).fid = user.fid;
      }

      const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        const data = (await res.json()) as { sessionToken?: string; fid?: number | null; quilAddress?: string };
        setState('success');

        // Update user context with passkey address so it's available immediately
        if (data.quilAddress) {
          // After linking to FC, the existing session is updated server-side,
          // but we also update the in-memory user state
          // (AuthContext will pick up the updated session on next page load)
          console.log('[PasskeySignIn] ✅ Passkey linked, address:', data.quilAddress.substring(0, 12) + '...');
        }

        if (data.sessionToken) {
          // New passkey-only account — store session and log in
          localStorage.setItem('passkey_session_token', data.sessionToken);
          setTimeout(() => {
            handlePasskeyAuth(passkey.address, data.sessionToken!, data.fid, passkey.displayName);
            closePasskeyModal();
          }, 600);
        } else {
          // Linked to existing FC account — session already updated server-side
          setTimeout(() => closePasskeyModal(), 800);
        }
      } else {
        const errBody = await res.text().catch(() => 'unknown');
        console.error('[PasskeySignIn] Register failed:', res.status, errBody);
        setState('error');
        setErrorMessage('Could not create passkey. Please try again.');
      }
    } catch (err: any) {
      if (err?.name === 'NotAllowedError') {
        setState('idle');
      } else {
        console.error('[PasskeySignIn] Registration error:', err);
        setState('error');
        setErrorMessage('Could not create passkey. Please try again.');
      }
    }
  }, [user?.sessionToken, user?.fid, handlePasskeyAuth, closePasskeyModal]);

  // "Clear passkey & create new" — clears localStorage and starts registration
  const handleClearAndRegister = useCallback(() => {
    localStorage.removeItem('qbase-passkeys');
    localStorage.removeItem('passkey_session_token');
    handleRegister();
  }, [handleRegister]);

  // "Sign in with Passkey" button click
  const handleSignIn = useCallback(async () => {
    if (currentPasskey?.address) {
      // Returning user — signLoginChallenge runs the WebAuthn ceremony
      // (biometric + PRF eval) inside performPasskeyLogin.
      setState('authenticating');
      try {
        const { data } = await performPasskeyLogin({ address: currentPasskey.address });

        if (data.sessionToken) {
          localStorage.setItem('passkey_session_token', data.sessionToken);
          setState('success');
          setTimeout(() => {
            handlePasskeyAuth(currentPasskey.address, data.sessionToken!, data.fid, data.fname || data.displayName || currentPasskey.displayName, data.pfpUrl);
            closePasskeyModal();
          }, 600);
        } else {
          setState('error');
          setErrorMessage(data.error || 'Authentication failed. Try creating a new passkey.');
        }
      } catch (err: any) {
        if (err?.name === 'NotAllowedError') {
          setState('idle');
        } else {
          setState('error');
          setErrorMessage('Authentication failed. Please try again.');
        }
      }
    } else {
      let staleCredentialId: string | null = null;
      // No localStorage — use discoverable credential auth.
      // The browser/OS picks the credential, server resolves it to an address,
      // but signing the challenge requires the local Ed448 key — which only
      // exists in localStorage of the device that registered. If absent,
      // direct the user to register on this device.
      setState('authenticating');
      try {
        const disc = await discover();
        staleCredentialId = disc.credentialId;
        const { address, data } = await performPasskeyLogin({ credentialId: disc.credentialId });

        if (data.sessionToken) {
          localStorage.setItem('passkey_session_token', data.sessionToken);
          setState('success');
          setTimeout(() => {
            handlePasskeyAuth(
              address,
              data.sessionToken!,
              data.fid,
              data.fname || data.displayName || 'Passkey User',
              data.pfpUrl
            );
            closePasskeyModal();
          }, 600);
        } else {
          setState('error');
          setErrorMessage(data.error || 'Account not found. Try creating a new passkey.');
        }
      } catch (err: any) {
        if (err?.name === 'NotAllowedError') {
          setState('idle');
        } else if (typeof err?.message === 'string' && err.message.startsWith('No passkey found for address')) {
          // The discoverable credential is registered but this browser has no
          // local Ed448 key for it (different device, cleared storage, an old
          // passkey). Where the browser supports it, tell the authenticator
          // the credential is dead so it stops being offered.
          forgetStalePasskey(staleCredentialId);
          setState('error');
          setErrorMessage('That passkey is from an older setup and can\'t sign in on this device. Try again to pick a different passkey, or create a new one.');
        } else {
          console.error('[PasskeySignIn] Discoverable auth error:', err);
          setState('error');
          setErrorMessage('No passkey found on this device. Try creating one first.');
        }
      }
    }
  }, [currentPasskey, handlePasskeyAuth, closePasskeyModal]);

  const handleRetry = useCallback(() => {
    setState('idle');
    setErrorMessage('');
    loginAttemptedRef.current = false;
  }, []);

  const handleClose = useCallback(() => {
    setState('idle');
    closePasskeyModal();
  }, [closePasskeyModal]);

  if (!showPasskeyModal) {
    return null;
  }

  return (
    <div className="passkey-modal-overlay">
      <div className="passkey-modal-card">
        <button className="passkey-modal-close" onClick={handleClose} aria-label="Close">
          ✕
        </button>

        {state === 'idle' && (
          <>
            <div className="passkey-modal-logo">
              <img src="/qbase.svg" alt="qbase" className="passkey-modal-logo-img" />
            </div>
            {user?.sessionToken ? (
              // Already authenticated (e.g., via FC) — offer to add a passkey
              <>
                <h2 className="passkey-modal-title">Add a passkey</h2>
                <p className="passkey-modal-subtitle">
                  Enable quick, biometric sign-in on any device. Your existing session stays active.
                </p>
                <div className="auth-options">
                  <button className="passkey-modal-btn-primary" onClick={handleRegister}>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                    </svg>
                    Create a Passkey
                  </button>
                </div>
              </>
            ) : (
              // Not authenticated — sign in or sign up
              <>
                <h2 className="passkey-modal-title">Welcome to qbase</h2>
                <p className="passkey-modal-subtitle">
                  Sign in to continue
                </p>
                <div className="auth-options">
                  <SignInButton
                    nonce={fetchAuthNonce}
                    onSuccess={async (res: StatusAPIResponse) => {
                      if (!handleWebAuth) return;
                      // Stay open until qbase's session exists: closing on the
                      // Farcaster callback left a few seconds with no modal and
                      // no sign-in (prod smoke 2026-09-26).
                      setState('farcaster');
                      try {
                        await handleWebAuth(res);
                      } finally {
                        setState('idle');
                        closePasskeyModal();
                      }
                    }}
                    onError={(error) => {
                      console.error('[PasskeySignIn] SignInButton error:', error);
                    }}
                  />
                  <div className="auth-divider">
                    <span>or</span>
                  </div>
                  <button className="passkey-modal-btn-primary" onClick={handleSignIn}>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                    </svg>
                    Sign in with Passkey
                  </button>
                  {accountMethods.ethereum && (
                    <button
                      className="passkey-modal-btn-secondary"
                      disabled={accountAuthBusy}
                      onClick={async () => { if (await loginWithEthereum()) closePasskeyModal(); }}
                    >
                      Sign in with Ethereum (ENS)
                    </button>
                  )}
                  {accountMethods.world && (
                    <button className="passkey-modal-btn-secondary" disabled={accountAuthBusy} onClick={() => { void loginWithWorld(); }}>
                      Sign in with World ID
                    </button>
                  )}
                  {accountAuthError && <p className="passkey-modal-error-msg">{accountAuthError}</p>}
                </div>
              </>
            )}
          </>
        )}

        {state === 'farcaster' && (
          <>
            <div className="passkey-modal-spinner" />
            <h2 className="passkey-modal-title">Signing in...</h2>
            <p className="passkey-modal-subtitle">Finishing your Farcaster sign-in</p>
          </>
        )}

        {state === 'authenticating' && (
          <>
            <div className="passkey-modal-spinner" />
            <h2 className="passkey-modal-title">Signing in...</h2>
            <p className="passkey-modal-subtitle">
              Verify with your device
            </p>
          </>
        )}

        {state === 'registering' && (
          <>
            <div className="passkey-modal-spinner" />
            <h2 className="passkey-modal-title">Creating passkey...</h2>
            <p className="passkey-modal-subtitle">
              Follow the prompts from your browser
            </p>
          </>
        )}

        {state === 'success' && (
          <>
            <div className="passkey-modal-checkmark">{"\u2713"}</div>
            <h2 className="passkey-modal-title">Signed in!</h2>
          </>
        )}

        {state === 'error' && (
          <>
            <div className="passkey-modal-logo passkey-modal-logo-error">!</div>
            <h2 className="passkey-modal-title">Sign in failed</h2>
            <p className="passkey-modal-error-msg">{errorMessage}</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <button className="passkey-modal-btn-primary" onClick={handleRetry}>
                Try again
              </button>
              <button className="passkey-modal-btn-retry" onClick={handleClearAndRegister}>
                {user?.sessionToken ? 'Clear passkey & create new' : 'Create a new passkey'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default PasskeySignInModal;
