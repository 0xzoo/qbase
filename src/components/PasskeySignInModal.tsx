/**
 * PasskeySignInModal
 *
 * Custom sign-in modal that uses the Quilibrium SDK's passkey functions
 * directly (register, completeRegistration, authenticate) without
 * rendering the SDK's PasskeyModal component.
 *
 * States: idle -> authenticating | registering -> success -> close
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { usePasskeysContext, FQ_APP_PREFIX } from '../quilibrium';
import { passkey as passkeySDK } from '@quilibrium/quilibrium-js-sdk-channels';
import './PasskeySignInModal.css';

type ModalState = 'idle' | 'authenticating' | 'registering' | 'success' | 'error';

export function PasskeySignInModal() {
  const {
    showPasskeyModal,
    handlePasskeyAuth,
    closePasskeyModal,
    user,
  } = useAuth();

  const ctx = usePasskeysContext();
  const { currentPasskeyInfo } = ctx;
  const setShowPasskeyPrompt = (ctx as any).setShowPasskeyPrompt;

  // Suppress SDK's built-in PasskeyModal — we render our own UI
  useEffect(() => {
    if (setShowPasskeyPrompt) {
      setShowPasskeyPrompt({ value: false });
    }
  }, [setShowPasskeyPrompt]);

  const [state, setState] = useState<ModalState>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const loginAttemptedRef = useRef(false);

  // Reset state when modal opens
  useEffect(() => {
    if (showPasskeyModal) {
      setState('idle');
      setErrorMessage('');
      loginAttemptedRef.current = false;
    }
  }, [showPasskeyModal]);

  // Auto-login for returning users (passkey already stored in IndexedDB)
  useEffect(() => {
    if (!showPasskeyModal || loginAttemptedRef.current) return;
    if (!currentPasskeyInfo?.address) return;

    // Already authenticated?
    if (user?.passkeyAddress === currentPasskeyInfo.address && user?.sessionToken) {
      closePasskeyModal();
      return;
    }

    loginAttemptedRef.current = true;
    setState('authenticating');

    const address = currentPasskeyInfo.address;
    const displayName = currentPasskeyInfo.displayName || undefined;

    (async () => {
      try {
        // Authenticate via SDK (triggers WebAuthn biometric/PIN prompt)
        await passkeySDK.authenticate(FQ_APP_PREFIX, {
          credentialId: currentPasskeyInfo.credentialId,
        });

        // Exchange with our backend
        const res = await fetch('/api/auth/passkey/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address }),
        });
        const data = (await res.json()) as { sessionToken?: string; fid?: number };

        if (data.sessionToken && data.fid) {
          localStorage.setItem('passkey_session_token', data.sessionToken);
          setState('success');
          setTimeout(() => {
            handlePasskeyAuth(address, data.sessionToken!, data.fid!, displayName);
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
  }, [showPasskeyModal, currentPasskeyInfo?.address, currentPasskeyInfo?.credentialId, currentPasskeyInfo?.displayName, user?.passkeyAddress, user?.sessionToken, handlePasskeyAuth, closePasskeyModal]);

  // "Sign in with Passkey" button click
  const handleSignIn = useCallback(async () => {
    if (currentPasskeyInfo?.address) {
      // Returning user — authenticate
      setState('authenticating');
      try {
        await passkeySDK.authenticate(FQ_APP_PREFIX, {
          credentialId: currentPasskeyInfo.credentialId,
        });

        const res = await fetch('/api/auth/passkey/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address: currentPasskeyInfo.address }),
        });
        const data = (await res.json()) as { sessionToken?: string; fid?: number };

        if (data.sessionToken && data.fid) {
          localStorage.setItem('passkey_session_token', data.sessionToken);
          setState('success');
          setTimeout(() => {
            handlePasskeyAuth(currentPasskeyInfo.address, data.sessionToken!, data.fid!, currentPasskeyInfo.displayName);
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
      // New user — register via SDK
      setState('registering');
      try {
        // Step 1: Create WebAuthn credential
        const account = `${FQ_APP_PREFIX}-${Date.now()}`;
        const regResult = await passkeySDK.register(FQ_APP_PREFIX, account);

        // Step 2: Get stored passkeys to find the new one
        const storedPasskeys = await passkeySDK.getStoredPasskeys();
        const newPasskey = storedPasskeys.find(p => p.credentialId === regResult.rawId) || storedPasskeys[0];

        if (!newPasskey) {
          throw new Error('Passkey registration completed but no stored passkey found');
        }

        // Step 3: Complete registration with largeBlob (stores Quilibrium keys)
        await passkeySDK.completeRegistration(FQ_APP_PREFIX, {
          credentialId: newPasskey.credentialId,
          address: newPasskey.address,
          publicKey: newPasskey.publicKey,
          largeBlob: '', // SDK populates this internally
          displayName: newPasskey.displayName,
        });

        // Step 4: Register with our backend
        const res = await fetch('/api/auth/passkey/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            address: newPasskey.address,
            publicKey: newPasskey.publicKey,
            credentialId: newPasskey.credentialId,
            displayName: newPasskey.displayName,
            registrationData: {
              credentialId: newPasskey.credentialId,
              publicKey: newPasskey.publicKey,
              user_public_key: newPasskey.publicKey,
            },
          }),
        });

        if (res.ok) {
          const data = (await res.json()) as { sessionToken?: string; fid?: number };
          if (data.sessionToken && data.fid) {
            localStorage.setItem('passkey_session_token', data.sessionToken);
            setState('success');
            setTimeout(() => {
              handlePasskeyAuth(newPasskey.address, data.sessionToken!, data.fid!, newPasskey.displayName);
              closePasskeyModal();
            }, 600);
          } else {
            setState('error');
            setErrorMessage('Registration failed. Please try again.');
          }
        } else {
          const errBody = await res.text().catch(() => 'unknown');
          console.error('[PasskeySignIn] Register failed:', res.status, errBody);
          setState('error');
          setErrorMessage('Registration failed. Please try again.');
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
    }
  }, [currentPasskeyInfo, handlePasskeyAuth, closePasskeyModal]);

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
          \u2715
        </button>

        {state === 'idle' && (
          <>
            <div className="passkey-modal-logo">q</div>
            <h2 className="passkey-modal-title">Welcome to qbase</h2>
            <p className="passkey-modal-subtitle">
              Sign in securely with your device passkey
            </p>
            <button className="passkey-modal-btn-primary" onClick={handleSignIn}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
              Sign in with Passkey
            </button>
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
            <div className="passkey-modal-checkmark">\u2713</div>
            <h2 className="passkey-modal-title">Signed in!</h2>
          </>
        )}

        {state === 'error' && (
          <>
            <div className="passkey-modal-logo" style={{ background: '#ef4444' }}>!</div>
            <h2 className="passkey-modal-title">Sign in failed</h2>
            <p className="passkey-modal-error-msg">{errorMessage}</p>
            <button className="passkey-modal-btn-retry" onClick={handleRetry}>
              Try again
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export default PasskeySignInModal;
