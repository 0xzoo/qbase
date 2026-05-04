import React, { useState } from 'react';
import {
  register,
  getPublicPasskeys,
  getCurrentPasskey,
  signWithPasskey,
  removePasskey,
  type StoredPasskey,
} from '../crypto/passkey';

/**
 * Passkey test page — uses native WebAuthn + @noble/curves Ed448
 * Visit http://localhost:5173/dev/passkey-test to test
 */
function PasskeyTestPage() {
  const [currentPasskey, setCurrentPasskey] = useState<StoredPasskey | null>(() => getCurrentPasskey());
  const [signature, setSignature] = useState<string | null>(null);
  const [sessionToken, setSessionToken] = useState<string | null>(() => {
    try {
      return localStorage.getItem('passkey_session_token');
    } catch {
      return null;
    }
  });
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [allPasskeys, setAllPasskeys] = useState<StoredPasskey[]>(() => getPublicPasskeys());

  const isAuthenticated = !!currentPasskey?.address;

  const handleRegister = async () => {
    try {
      setStatusMsg('Creating passkey...');
      const result = await register();
      setCurrentPasskey(result.passkey);
      setAllPasskeys(getPublicPasskeys());
      setStatusMsg(`✅ Registered: ${result.passkey.address}`);

      // Also register with backend
      const res = await fetch('/api/auth/passkey/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address: result.passkey.address,
          publicKey: result.passkey.publicKey,
          credentialId: result.passkey.credentialId,
          displayName: result.passkey.displayName,
          registrationData: {
            credentialId: result.passkey.credentialId,
            publicKey: result.passkey.publicKey,
            user_public_key: result.passkey.publicKey,
          },
        }),
      });

      if (res.ok) {
        const data = await res.json() as { sessionToken?: string; fid?: number };
        if (data.sessionToken) {
          localStorage.setItem('passkey_session_token', data.sessionToken);
          setSessionToken(data.sessionToken);
          setStatusMsg(`✅ Registered + session created (FID: ${data.fid})`);
        }
      } else {
        setStatusMsg(`✅ Passkey created, but backend register failed: ${res.status}`);
      }
    } catch (err: any) {
      setStatusMsg(`❌ Register failed: ${err.message}`);
    }
  };

  const handleAuthenticate = async () => {
    if (!currentPasskey) {
      setStatusMsg('No passkey stored — register first');
      return;
    }
    try {
      setStatusMsg('Authenticating...');
      // Server-issued challenge → signLoginChallenge runs the WebAuthn
      // ceremony (biometric + PRF eval) and signs the challenge.
      const { signLoginChallenge } = await import('../crypto/passkey');
      const chRes = await fetch(`/api/auth/passkey/challenge?address=${encodeURIComponent(currentPasskey.address)}`);
      if (!chRes.ok) {
        setStatusMsg(`❌ Challenge failed: ${chRes.status}`);
        return;
      }
      const { challenge } = await chRes.json() as { challenge: string };
      const signature = await signLoginChallenge(currentPasskey.address, challenge);

      const res = await fetch('/api/auth/passkey/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: currentPasskey.address, signature }),
      });
      const data = await res.json() as { sessionToken?: string; fid?: number };
      if (data.sessionToken) {
        localStorage.setItem('passkey_session_token', data.sessionToken);
        setSessionToken(data.sessionToken);
        setStatusMsg(`✅ Session created (FID: ${data.fid})`);
      }
    } catch (err: any) {
      setStatusMsg(`❌ Auth failed: ${err.message}`);
    }
  };

  const handleSign = async () => {
    if (!currentPasskey) {
      setStatusMsg('No passkey — register first');
      return;
    }
    try {
      setStatusMsg('Signing...');
      const payload = new TextEncoder().encode('test payload for qbase');
      const sig = await signWithPasskey(currentPasskey.address, payload);
      const sigHex = Array.from(sig).map(b => b.toString(16).padStart(2, '0')).join('');
      setSignature(sigHex);
      setStatusMsg(`✅ Signed (${sig.length} bytes)`);
    } catch (err: any) {
      setStatusMsg(`❌ Sign failed: ${err.message}`);
    }
  };

  const handleClear = () => {
    if (currentPasskey) {
      removePasskey(currentPasskey.credentialId);
    }
    localStorage.removeItem('passkey_session_token');
    setCurrentPasskey(null);
    setSessionToken(null);
    setSignature(null);
    setAllPasskeys(getPublicPasskeys());
    setStatusMsg('Cleared all local state');
  };

  return (
    <div style={{ padding: '2rem', maxWidth: '700px', margin: '0 auto', fontFamily: 'monospace' }}>
      <h1 style={{ fontSize: '1.5rem', marginBottom: '1rem' }}>🔐 Passkey Test</h1>
      <p style={{ color: '#888', marginBottom: '2rem' }}>
        Native WebAuthn + @noble/curves Ed448 (no SDK)
      </p>

      {/* Status */}
      {statusMsg && (
        <div style={{
          padding: '0.75rem 1rem',
          borderRadius: '8px',
          background: statusMsg.startsWith('✅') ? '#0a2e0a' : statusMsg.startsWith('❌') ? '#2e0a0a' : '#1a1a2e',
          color: statusMsg.startsWith('✅') ? '#4ade80' : statusMsg.startsWith('❌') ? '#f87171' : '#93c5fd',
          marginBottom: '1.5rem',
          fontSize: '0.875rem',
          wordBreak: 'break-all',
        }}>
          {statusMsg}
        </div>
      )}

      {/* Current State */}
      <div style={{ marginBottom: '2rem' }}>
        <h2 style={{ fontSize: '1rem', marginBottom: '0.5rem' }}>State</h2>
        <div style={{ fontSize: '0.8rem', color: '#aaa', lineHeight: '1.8' }}>
          <div>Authenticated: {isAuthenticated ? '✅ Yes' : '❌ No'}</div>
          <div>Address: {currentPasskey?.address || 'none'}</div>
          <div>Credential ID: {currentPasskey?.credentialId?.substring(0, 20) || 'none'}...</div>
          <div>Session Token: {sessionToken ? `${sessionToken.substring(0, 20)}...` : 'none'}</div>
          <div>Stored Passkeys: {allPasskeys.length}</div>
        </div>
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginBottom: '2rem' }}>
        <button onClick={handleRegister} style={btnStyle}>
          🆕 Register New Passkey
        </button>
        <button onClick={handleAuthenticate} style={btnStyle} disabled={!currentPasskey}>
          🔑 Authenticate
        </button>
        <button onClick={handleSign} style={btnStyle} disabled={!currentPasskey}>
          ✍️ Sign Test Payload (Ed448)
        </button>
        <button onClick={handleClear} style={{ ...btnStyle, background: '#7f1d1d' }}>
          🗑️ Clear All Local State
        </button>
      </div>

      {/* Signature output */}
      {signature && (
        <div style={{ marginBottom: '2rem' }}>
          <h2 style={{ fontSize: '1rem', marginBottom: '0.5rem' }}>Ed448 Signature</h2>
          <div style={{
            fontSize: '0.7rem',
            color: '#4ade80',
            background: '#0a0a0a',
            padding: '1rem',
            borderRadius: '8px',
            wordBreak: 'break-all',
            maxHeight: '200px',
            overflow: 'auto',
          }}>
            {signature}
          </div>
        </div>
      )}

      {/* Public key info */}
      {currentPasskey?.publicKey && (
        <div style={{ marginBottom: '2rem' }}>
          <h2 style={{ fontSize: '1rem', marginBottom: '0.5rem' }}>Ed448 Public Key</h2>
          <div style={{
            fontSize: '0.7rem',
            color: '#93c5fd',
            background: '#0a0a0a',
            padding: '1rem',
            borderRadius: '8px',
            wordBreak: 'break-all',
          }}>
            [{currentPasskey.publicKey.join(', ')}]
          </div>
          <div style={{ fontSize: '0.75rem', color: '#888', marginTop: '0.5rem' }}>
            <span>Ed448 keypair stored locally (no WASM, no SDK)</span>
          </div>
        </div>
      )}
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  padding: '0.75rem 1.25rem',
  borderRadius: '8px',
  border: '1px solid #333',
  background: '#1a1a2e',
  color: '#e5e5e5',
  fontSize: '0.875rem',
  cursor: 'pointer',
  textAlign: 'left',
};

export default PasskeyTestPage;
