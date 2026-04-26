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
import { register, authenticate, discover, getCurrentPasskey, removePasskey } from '../crypto/passkey';
import './PasskeySignInModal.css';

type ModalState = 'idle' | 'authenticating' | 'registering' | 'success' | 'error';

export function PasskeySignInModal() {
  const {
    showPasskeyModal,
    handlePasskeyAuth,
    handleWebAuth,
    closePasskeyModal,
    user,
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

    const { address, displayName, credentialId } = currentPasskey;

    (async () => {
      try {
        // Authenticate via native WebAuthn (triggers biometric/PIN)
        await authenticate(credentialId);

        // Exchange with our backend
        const res = await fetch('/api/auth/passkey/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address }),
        });
        const data = (await res.json()) as { sessionToken?: string; fid?: number | null; displayName?: string; fname?: string; pfpUrl?: string | null };

        if (data.sessionToken) {
          localStorage.setItem('passkey_session_token', data.sessionToken);
          setState('success');
          setTimeout(() => {
            handlePasskeyAuth(address, data.sessionToken!, data.fid, data.fname || data.displayName || displayName, data.pfpUrl);
            closePasskeyModal();
          }, 600);
        } else {
          setState('error');
          setErrorMessage('Account not found. Try creating a new passkey.');
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
      const result = await register();
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
      // Returning user — authenticate via stored credentialId
      setState('authenticating');
      try {
        await authenticate(currentPasskey.credentialId);

        const res = await fetch('/api/auth/passkey/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address: currentPasskey.address }),
        });
        const data = (await res.json()) as { sessionToken?: string; fid?: number | null; displayName?: string; fname?: string; pfpUrl?: string | null };

        if (data.sessionToken) {
          localStorage.setItem('passkey_session_token', data.sessionToken);
          setState('success');
          setTimeout(() => {
            handlePasskeyAuth(currentPasskey.address, data.sessionToken!, data.fid, data.fname || data.displayName || currentPasskey.displayName, data.pfpUrl);
            closePasskeyModal();
          }, 600);
        } else {
          setState('error');
          setErrorMessage('Account not found. Try creating a new passkey.');
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
      // No localStorage — use discoverable credential auth
      // The browser/OS will prompt the user to pick from their stored passkeys
      setState('authenticating');
      try {
        const disc = await discover();
        const res = await fetch('/api/auth/passkey/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ credentialId: disc.credentialId }),
        });
        const data = (await res.json()) as { sessionToken?: string; fid?: number | null; displayName?: string; fname?: string; pfpUrl?: string | null; error?: string };

        if (data.sessionToken) {
          localStorage.setItem('passkey_session_token', data.sessionToken);
          setState('success');
          setTimeout(() => {
            handlePasskeyAuth(
              data.fid ? `passkey-${data.fid}` : '',
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
                    onSuccess={(res: StatusAPIResponse) => {
                      if (handleWebAuth) {
                        handleWebAuth(res);
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
                </div>
              </>
            )}
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
                Clear passkey & create new
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default PasskeySignInModal;
