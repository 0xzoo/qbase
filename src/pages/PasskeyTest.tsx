import React, { useState } from 'react';
import { usePasskeysContext, PasskeyModal, FQ_APP_PREFIX } from '../quilibrium';

/**
 * Simple passkey test page
 * Visit http://localhost:5173/dev/passkey-test to test
 */
function PasskeyTestPage() {
  const { currentPasskeyInfo, signWithPasskey: sdkSign } = usePasskeysContext();
  const [showModal, setShowModal] = useState(false);
  const [signature, setSignature] = useState<string | null>(null);

  const isAuthenticated = !!currentPasskeyInfo?.address;

  const handleSignMessage = async () => {
    try {
      if (!currentPasskeyInfo?.credentialId) {
        alert('Not authenticated. Please sign in/register first.');
        return;
      }

      const message = `qbase test - ${Date.now()}`;
      const payload = new TextEncoder().encode(message);
      
      // SDK expects base64-encoded payload
      const payloadBase64 = btoa(String.fromCharCode(...payload));
      const signatureBase64 = await sdkSign(currentPasskeyInfo.credentialId, payloadBase64);
      
      setSignature(signatureBase64);
      console.log('✅ Signature created:', {
        message,
        signature: signatureBase64,
        signatureBytes: Uint8Array.from(atob(signatureBase64), c => c.charCodeAt(0)),
      });
      alert(`Signature created!\n\nLength: ${signatureBase64.length} chars\nCheck console for details.`);
    } catch (error) {
      console.error('❌ Signing failed:', error);
      alert(`Signing failed: ${error}`);
    }
  };

  const handleCopyAddress = () => {
    if (currentPasskeyInfo?.address) {
      navigator.clipboard.writeText(currentPasskeyInfo.address);
      alert(`Address copied:\n${currentPasskeyInfo.address}`);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-50 to-blue-50 p-8">
      <div className="max-w-2xl mx-auto">
        <h1 className="text-4xl font-bold text-gray-900 mb-2 text-center">
          🦝 qbase Passkey Test
        </h1>
        <p className="text-gray-600 text-center mb-8">
          Simple passkey auth test - uses Touch ID / Face ID / Windows Hello
        </p>

        <div className="bg-white rounded-2xl shadow-xl p-8 mb-6">
          {isAuthenticated ? (
            <div className="space-y-4">
              <div className="p-4 bg-green-50 border border-green-200 rounded-lg">
                <div className="flex items-center gap-2 text-green-800 font-semibold">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  Authenticated
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

              <button
                onClick={handleSignMessage}
                className="w-full px-6 py-3 bg-gradient-to-r from-purple-600 to-blue-600 text-white font-semibold rounded-lg hover:from-purple-700 hover:to-blue-700 transition-all shadow-md"
              >
                🔐 Test Signing
              </button>

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

              <div className="pt-4 border-t border-gray-200">
                <p className="text-sm text-gray-600 text-center">
                  To test again, close this tab and reopen (passkeys persist in your device)
                </p>
              </div>
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
                    <span>Biometric (touch/face) signs challenges - no passwords!</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="text-blue-600 font-bold">4.</span>
                    <span>Address derived as: <code className="bg-blue-100 px-1 rounded">Qm... = SHA256(pubkey) → base58</code></span>
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
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
            <div className="bg-white rounded-2xl max-w-md w-full p-6 relative">
              <button
                onClick={() => setShowModal(false)}
                className="absolute top-4 right-4 text-gray-400 hover:text-gray-600"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
              
              <h2 className="text-xl font-bold text-gray-900 mb-4">Passkey Manager</h2>
              <p className="text-gray-600 mb-6">
                Use this modal to register a new passkey or sign in with an existing one.
              </p>
              
              {/* Force modal visible - SDK state issue */}
              <style>{`
                [style*="z-index: 10000"].hidden { display: flex !important; }
              `}</style>
              
              <PasskeyModal
                fqAppPrefix={FQ_APP_PREFIX}
                getUserRegistration={async (address) => {
                  try {
                    const stored = localStorage.getItem(`passkey-${address}`);
                    if (stored) {
                      console.log('[Passkey] Found registration for:', address);
                      return JSON.parse(stored);
                    }
                    throw new Error('Registration not found');
                  } catch (err) {
                    console.error('[Passkey] Get registration error:', err);
                    throw err;
                  }
                }}
                uploadRegistration={async ({ address, registration }) => {
                  localStorage.setItem(`passkey-${address}`, JSON.stringify(registration));
                  console.log('[Passkey] ✅ Registration saved for:', address);
                }}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default PasskeyTestPage;
