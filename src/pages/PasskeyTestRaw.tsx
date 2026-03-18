import React, { useState } from 'react';

/**
 * Simple passkey test using raw WebAuthn API (no SDK)
 * This tests if passkeys work on this device/browser
 */
function PasskeyTestRaw() {
  const [credential, setCredential] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);

  const addLog = (msg: string) => {
    console.log(msg);
    setLogs(prev => [...prev, msg]);
  };

  const handleRegister = async () => {
    try {
      setError(null);
      addLog('🔐 Starting registration...');

      // Generate a challenge (random bytes)
      const challenge = new Uint8Array(32);
      crypto.getRandomValues(challenge);

      // Create passkey
      const cred = await navigator.credentials.create({
        publicKey: {
          challenge,
          rp: {
            name: 'qbase',
            id: window.location.hostname === 'localhost' 
              ? 'localhost' 
              : window.location.hostname,
          },
          user: {
            id: new Uint8Array([1, 2, 3]), // Simple user ID
            name: `user-${Date.now()}@qbase.local`,
            displayName: 'Qbase User',
          },
          pubKeyCredParams: [
            { type: 'public-key', alg: -7 },  // ES256
            { type: 'public-key', alg: -8 },  // Ed25519
          ],
          timeout: 60000,
          attestation: 'none',
          authenticatorSelection: {
            authenticatorAttachment: 'platform', // Use device biometrics
            requireResidentKey: false,
            userVerification: 'required',
          },
        },
      }) as PublicKeyCredential | null;

      if (!cred) {
        throw new Error('No credential created');
      }

      addLog('✅ Passkey created!');
      addLog(`   ID: ${cred.id}`);
      addLog(`   Type: ${cred.type}`);

      const response = cred.response as AuthenticatorAttestationResponse;
      addLog(`   AAGUID: ${new Uint8Array(response.getAuthenticatorData()).slice(0, 16).join(',')}`);

      setCredential({
        id: cred.id,
        rawId: Array.from(new Uint8Array(cred.rawId)),
        type: cred.type,
      });

      // Store for later auth test
      localStorage.setItem('test-passkey-id', cred.id);
      addLog('💾 Credential ID saved to localStorage');

    } catch (err: any) {
      setError(`Registration failed: ${err.message}`);
      addLog(`❌ Error: ${err.message}`);
      console.error('Registration error:', err);
    }
  };

  const handleAuthenticate = async () => {
    try {
      setError(null);
      addLog('🔓 Starting authentication...');

      const storedId = localStorage.getItem('test-passkey-id');
      if (!storedId) {
        throw new Error('No passkey registered. Register first!');
      }

      // Generate challenge
      const challenge = new Uint8Array(32);
      crypto.getRandomValues(challenge);

      // Authenticate with passkey
      const cred = await navigator.credentials.get({
        publicKey: {
          challenge,
          timeout: 60000,
          userVerification: 'required',
          rpId: window.location.hostname === 'localhost' 
            ? 'localhost' 
            : window.location.hostname,
          allowCredentials: [{
            id: new Uint8Array(
              storedId.split('').map(c => c.charCodeAt(0))
            ),
            type: 'public-key',
          }],
        },
      }) as PublicKeyCredential | null;

      if (!cred) {
        throw new Error('Authentication failed - no credential');
      }

      addLog('✅ Authentication successful!');
      addLog(`   Credential ID: ${cred.id}`);

      const response = cred.response as AuthenticatorAssertionResponse;
      addLog(`   Signature length: ${response.signature.byteLength} bytes`);

    } catch (err: any) {
      setError(`Authentication failed: ${err.message}`);
      addLog(`❌ Error: ${err.message}`);
      console.error('Auth error:', err);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-purple-50 p-8">
      <div className="max-w-2xl mx-auto">
        <h1 className="text-4xl font-bold text-gray-900 mb-2 text-center">
          🦝 qbase Passkey Test (Raw WebAuthn)
        </h1>
        <p className="text-gray-600 text-center mb-8">
          Direct WebAuthn API test - no SDK required
        </p>

        <div className="bg-white rounded-2xl shadow-xl p-8 mb-6 space-y-6">
          {/* Status */}
          <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg">
            <p className="text-blue-900 font-semibold mb-2">📋 Status</p>
            <ul className="text-sm text-blue-800 space-y-1">
              <li>• Browser: {navigator.userAgent.split(' ').pop()}</li>
              <li>• Secure Context: {window.isSecureContext ? '✅ Yes' : '❌ No'}</li>
              <li>• Public Key Credential: {window.PublicKeyCredential ? '✅ Supported' : '❌ Not supported'}</li>
            </ul>
          </div>

          {/* Actions */}
          <div className="grid grid-cols-2 gap-4">
            <button
              onClick={handleRegister}
              className="px-6 py-4 bg-gradient-to-r from-green-600 to-emerald-600 text-white font-semibold rounded-lg hover:from-green-700 hover:to-emerald-700 transition-all shadow-md"
            >
              🔑 Register Passkey
            </button>
            <button
              onClick={handleAuthenticate}
              className="px-6 py-4 bg-gradient-to-r from-blue-600 to-indigo-600 text-white font-semibold rounded-lg hover:from-blue-700 hover:to-indigo-700 transition-all shadow-md"
            >
              🔓 Authenticate
            </button>
          </div>

          {/* Error */}
          {error && (
            <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
              <p className="text-red-800 font-semibold">⚠️ {error}</p>
            </div>
          )}

          {/* Credential Info */}
          {credential && (
            <div className="p-4 bg-green-50 border border-green-200 rounded-lg">
              <p className="text-green-900 font-semibold mb-2">✅ Registered Credential</p>
              <code className="text-xs bg-white p-2 rounded block break-all font-mono">
                {JSON.stringify(credential, null, 2)}
              </code>
            </div>
          )}

          {/* Logs */}
          {logs.length > 0 && (
            <div className="p-4 bg-gray-50 border border-gray-200 rounded-lg">
              <p className="text-gray-700 font-semibold mb-2">📝 Activity Log</p>
              <div className="text-xs font-mono bg-white p-3 rounded max-h-64 overflow-auto space-y-1">
                {logs.map((log, i) => (
                  <div key={i} className="border-b border-gray-100 pb-1 last:border-0">
                    {log}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Info */}
          <div className="pt-4 border-t border-gray-200">
            <p className="text-sm text-gray-600 text-center">
              This test uses the browser's native WebAuthn API.
              <br />
              Your device will prompt for Touch ID / Face ID / Windows Hello.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

export default PasskeyTestRaw;
