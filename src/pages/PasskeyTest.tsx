import React, { useState } from 'react';
import { usePasskeysContext, PasskeyModal, FQ_APP_PREFIX } from '../quilibrium';

/**
 * Passkey test page — Phase 1b: uses D1 backend for registration storage
 * Visit http://localhost:5173/dev/passkey-test to test
 */
function PasskeyTestPage() {
  const { currentPasskeyInfo, signWithPasskey: sdkSign } = usePasskeysContext();
  const [showModal, setShowModal] = useState(false);
  const [signature, setSignature] = useState<string | null>(null);
  const [sessionToken, setSessionToken] = useState<string | null>(() => {
    try {
      return localStorage.getItem('passkey_session_token');
    } catch {
      return null;
    }
  });
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const isAuthenticated = !!currentPasskeyInfo?.address;

  // When auth completes: close modal + create session if we don't have one
  const wasAuthenticatedRef = React.useRef(isAuthenticated);
  React.useEffect(() => {
    if (isAuthenticated && !wasAuthenticatedRef.current) {
      // Auth just completed
      if (showModal) {
        const timer = setTimeout(() => setShowModal(false), 500);
        setTimeout(() => clearTimeout(timer), 600);
      }

      // If no session token, call login endpoint to create one
      if (!sessionToken && currentPasskeyInfo?.address) {
        fetch('/api/auth/passkey/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address: currentPasskeyInfo.address }),
        })
          .then(res => res.json())
          .then(data => {
            if (data.sessionToken) {
              localStorage.setItem('passkey_session_token', data.sessionToken);
              setSessionToken(data.sessionToken);
              setStatusMsg('✅ Session created via login');
              console.log('[Passkey] Session created via login for:', currentPasskeyInfo.address);
            }
          })
          .catch(err => console.error('[Passkey] Login failed:', err));
      }
    }
    wasAuthenticatedRef.current = isAuthenticated;
  }, [isAuthenticated, showModal, sessionToken, currentPasskeyInfo?.address]);

  // Intercept SDK Cancel/Continue/backdrop clicks to sync showModal state
  React.useEffect(() => {
    if (!showModal) return;

    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      
      // Backdrop click (the z-10000 wrapper itself, not its children)
      const sdkWrapper = document.querySelector<HTMLElement>('[style*="z-index: 10000"]');
      if (target === sdkWrapper) {
        setShowModal(false);
        return;
      }

      // Only close on Cancel — Continue advances SDK's multi-step flow
      if (target.classList.contains('cursor-pointer') && 
          target.textContent?.trim() === 'Cancel') {
        setTimeout(() => setShowModal(false), 150);
      }
    };

    document.addEventListener('click', handleClick, true);
    return () => document.removeEventListener('click', handleClick, true);
  }, [showModal]);

  const handleSignMessage = async () => {
    try {
      const addr = currentPasskeyInfo?.address;
      if (!addr) {
        console.warn('[Passkey] No address in currentPasskeyInfo:', currentPasskeyInfo);
        setStatusMsg('❌ Not authenticated. Open Passkey Manager first.');
        return;
      }

      const message = `qbase test - ${Date.now()}`;
      const payload = new TextEncoder().encode(message);
      
      // SDK expects base64-encoded payload
      // NOTE: SDK's signWithPasskey() looks up passkey by ADDRESS, not credentialId
      // (authenticate() does: passkeys.filter(p => p.address === request.credentialId))
      const payloadBase64 = btoa(String.fromCharCode(...payload));
      const signatureBase64 = await sdkSign(addr, payloadBase64);
      
      setSignature(signatureBase64);
      setStatusMsg('✅ Signature created successfully!');
      console.log('✅ Signature created:', {
        message,
        signature: signatureBase64,
        signatureBytes: Uint8Array.from(atob(signatureBase64), c => c.charCodeAt(0)),
      });
    } catch (error) {
      console.error('❌ Signing failed:', error);
      setStatusMsg(`❌ Signing failed: ${error}`);
    }
  };

  const handleTestSession = async () => {
    if (!sessionToken) {
      setStatusMsg('No session token — register or login first');
      return;
    }

    try {
      const res = await fetch('/api/auth/passkey/user', {
        headers: { 'Authorization': `Bearer ${sessionToken}` },
      });

      if (res.ok) {
        const user = await res.json();
        setStatusMsg(`✅ Session valid! User: ${user.display_name || user.address}`);
        console.log('[Passkey] User data:', user);
      } else {
        const err = await res.json();
        setStatusMsg(`❌ Session invalid: ${err.error}`);
      }
    } catch (error) {
      setStatusMsg(`❌ Error: ${error}`);
    }
  };

  const handleCopyAddress = () => {
    if (currentPasskeyInfo?.address) {
      navigator.clipboard.writeText(currentPasskeyInfo.address);
      setStatusMsg('Address copied!');
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-50 to-blue-50 p-8">
      <div className="max-w-2xl mx-auto">
        <h1 className="text-4xl font-bold text-gray-900 mb-2 text-center">
          🦝 qbase Passkey Test
        </h1>
        <p className="text-gray-600 text-center mb-2">
          Phase 1b — passkey auth with D1 backend
        </p>
        <p className="text-xs text-gray-400 text-center mb-8">
          Registrations saved to D1 • Sessions in KV • No localStorage
        </p>

        {statusMsg && (
          <div className={`mb-4 p-3 rounded-lg text-sm font-mono ${
            statusMsg.startsWith('✅') 
              ? 'bg-green-50 text-green-800 border border-green-200'
              : statusMsg.startsWith('❌')
              ? 'bg-red-50 text-red-800 border border-red-200'
              : 'bg-blue-50 text-blue-800 border border-blue-200'
          }`}>
            {statusMsg}
          </div>
        )}

        <div className="bg-white rounded-2xl shadow-xl p-8 mb-6">
          {isAuthenticated ? (
            <div className="space-y-4">
              <div className="p-4 bg-green-50 border border-green-200 rounded-lg">
                <div className="flex items-center gap-2 text-green-800 font-semibold">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  Authenticated
                  {sessionToken && <span className="text-xs font-normal ml-2">(session active)</span>}
                </div>
              </div>

              <div className="p-4 bg-gray-50 rounded-lg space-y-3">
                <div>
                  <label className="text-sm text-gray-600 font-medium">Your Address</label>
                  <div className="flex gap-2 mt-1">
                    <code className="flex-1 block p-2 bg-white border rounded text-sm font-mono break-all">
                      {currentPasskeyInfo.address}
                    </code>
                    <button
                      onClick={handleCopyAddress}
                      className="px-3 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors text-sm font-medium"
                      title="Copy address"
                    >
                      Copy
                    </button>
                  </div>
                </div>

                {currentPasskeyInfo.displayName && (
                  <div>
                    <label className="text-sm text-gray-600 font-medium">Display Name</label>
                    <div className="mt-1 text-gray-900 font-medium">
                      {currentPasskeyInfo.displayName}
                    </div>
                  </div>
                )}
              </div>

              <div className="flex gap-3">
                <button
                  onClick={handleSignMessage}
                  className="flex-1 px-6 py-3 bg-gradient-to-r from-purple-600 to-blue-600 text-white font-semibold rounded-lg hover:from-purple-700 hover:to-blue-700 transition-all shadow-md"
                >
                  🔐 Test Signing
                </button>
                <button
                  onClick={handleTestSession}
                  className="flex-1 px-6 py-3 bg-gradient-to-r from-green-600 to-teal-600 text-white font-semibold rounded-lg hover:from-green-700 hover:to-teal-700 transition-all shadow-md"
                >
                  🔑 Test Session
                </button>
              </div>

              {signature && (
                <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg">
                  <label className="text-sm text-blue-900 font-semibold block mb-2">
                    ✅ Signature (Base64):
                  </label>
                  <code className="block p-2 bg-white border rounded text-xs font-mono break-all text-gray-800 max-h-24 overflow-auto">
                    {signature}
                  </code>
                </div>
              )}

              <details className="text-xs text-gray-500">
                <summary className="cursor-pointer hover:text-gray-700">SDK State Debug</summary>
                <pre className="mt-2 p-2 bg-gray-50 rounded text-[10px] font-mono overflow-auto max-h-40">
{JSON.stringify({
  address: currentPasskeyInfo?.address,
  credentialId: currentPasskeyInfo?.credentialId ? currentPasskeyInfo.credentialId.substring(0, 20) + '...' : 'UNDEFINED',
  displayName: currentPasskeyInfo?.displayName,
  publicKey: currentPasskeyInfo?.publicKey ? String(currentPasskeyInfo.publicKey).substring(0, 30) + '...' : 'UNDEFINED',
  sessionToken: sessionToken ? sessionToken.substring(0, 8) + '...' : null,
}, null, 2)}
                </pre>
              </details>
            </div>
          ) : (
            <div className="space-y-6 text-center">
              <div className="p-4 bg-purple-50 border border-purple-200 rounded-lg">
                <p className="text-gray-700">
                  Click below to create or use a passkey. Your device will prompt for biometric authentication (Touch ID, Face ID, or Windows Hello).
                </p>
              </div>

              <button
                onClick={() => setShowModal(true)}
                className="w-full px-6 py-4 bg-gradient-to-r from-purple-600 to-blue-600 text-white font-semibold rounded-lg hover:from-purple-700 hover:to-blue-700 transition-all shadow-lg text-lg"
              >
                🔑 Open Passkey Manager
              </button>

              <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg text-left">
                <h3 className="font-semibold text-blue-900 mb-3 flex items-center gap-2">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  How it works
                </h3>
                <ul className="text-sm text-blue-800 space-y-2">
                  <li className="flex items-start gap-2">
                    <span className="text-blue-600 font-bold">1.</span>
                    <span>Passkeys use WebAuthn for phishing-resistant authentication</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-blue-600 font-bold">2.</span>
                    <span>Ed448 keypair stored in your device's secure enclave</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-blue-600 font-bold">3.</span>
                    <span>Registration saved to D1 database (not localStorage!)</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-blue-600 font-bold">4.</span>
                    <span>Session token in KV — same infra as Farcaster auth</span>
                  </li>
                </ul>
              </div>

              <div className="text-xs text-gray-500">
                <p>Supported browsers: Chrome 108+, Firefox 113+, Safari 16+</p>
                <p>Must use HTTPS or localhost</p>
              </div>
            </div>
          )}
        </div>

        {showModal && (
          <>
            {/* Force SDK modal visible if hidden */}
            <style>{`
              [style*="z-index: 10000"].hidden { display: flex !important; }
            `}</style>
            
            <PasskeyModal
                fqAppPrefix={FQ_APP_PREFIX}
                getUserRegistration={async (address) => {
                  try {
                    // Try localStorage first (SDK needs this for signing)
                    const cached = localStorage.getItem(`passkey-${address}`);
                    if (cached) {
                      console.log('[Passkey] Found registration in localStorage for:', address);
                      return JSON.parse(cached);
                    }

                    // Fall back to D1
                    const res = await fetch(`/api/auth/passkey/registration/${encodeURIComponent(address)}`);
                    if (!res.ok) {
                      throw new Error('Registration not found');
                    }
                    const data = await res.json();
                    console.log('[Passkey] Fetched registration from D1 for:', address);
                    
                    // Cache in localStorage for SDK signing
                    localStorage.setItem(`passkey-${address}`, JSON.stringify(data));
                    return data;
                  } catch (err) {
                    console.error('[Passkey] Get registration error:', err);
                    throw err;
                  }
                }}
                uploadRegistration={async ({ address, registration }) => {
                  try {
                    // CRITICAL: Save to localStorage first — SDK needs this for signing
                    localStorage.setItem(`passkey-${address}`, JSON.stringify(registration));
                    console.log('[Passkey] Saved registration to localStorage for SDK signing');

                    // Then persist to D1 (async, non-blocking for UX)
                    const res = await fetch('/api/auth/passkey/register', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        address: address,
                        publicKey: currentPasskeyInfo?.publicKey 
                          ? (typeof currentPasskeyInfo.publicKey === 'string' 
                            ? currentPasskeyInfo.publicKey 
                            : String(currentPasskeyInfo.publicKey))
                          : '',
                        displayName: currentPasskeyInfo?.displayName || undefined,
                        credentialId: currentPasskeyInfo?.credentialId || '',
                        registrationData: registration,
                      }),
                    });

                    if (res.ok) {
                      const data = await res.json();
                      // Save session token
                      if (data.sessionToken) {
                        localStorage.setItem('passkey_session_token', data.sessionToken);
                        setSessionToken(data.sessionToken);
                      }
                      setStatusMsg(`✅ ${data.isNewUser ? 'Registered' : 'Updated'}! Saved to D1 + localStorage.`);
                      console.log('[Passkey] ✅ Registration saved to D1:', data);
                    } else {
                      const err = await res.json();
                      console.error('[Passkey] D1 save failed (localStorage still works):', err);
                      setStatusMsg(`⚠️ Saved locally but D1 sync failed: ${err.error}`);
                    }
                  } catch (err) {
                    console.error('[Passkey] Upload registration error:', err);
                    setStatusMsg(`⚠️ Saved locally but D1 sync failed: ${err}`);
                    // Don't throw — localStorage save succeeded, signing will work
                  }
                }}
            />
          </>
        )}
      </div>
    </div>
  );
}

export default PasskeyTestPage;
