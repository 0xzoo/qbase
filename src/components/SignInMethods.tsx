/**
 * Settings → Sign-in methods (docs/specs/account-root.md §6.2–6.3).
 *
 * Lists the credentials on the signed-in account and links new ones. Only
 * shown once the server has cut over to accounts (GET /api/account/credentials
 * answers 503 before that, and the section hides itself).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { KeyRound } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

interface Cred { kind: 'farcaster' | 'passkey' | 'ethereum' | 'world'; value: string; label: string | null; id: string }

const KIND_LABEL: Record<Cred['kind'], string> = { farcaster: 'Farcaster', passkey: 'Passkey', ethereum: 'Ethereum', world: 'World ID' };

function describe(c: Cred): string {
  if (c.kind === 'ethereum') return c.label ?? `${c.value.slice(0, 6)}…${c.value.slice(-4)}`;
  if (c.kind === 'farcaster') return c.label ? `@${c.label}` : `fid ${c.value}`;
  if (c.kind === 'passkey') return c.label ?? 'this device';
  return 'verified human';
}

const SignInMethods: React.FC = () => {
  const { getAuthToken, accountMethods, accountAuthBusy, accountAuthError, linkEthereum, linkWorld } = useAuth();
  const [creds, setCreds] = useState<Cred[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const token = getAuthToken();
    if (!token) return;
    const r = await fetch('/api/account/credentials', { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) { setCreds(null); return; }
    setCreds(((await r.json()) as { credentials: Cred[] }).credentials);
  }, [getAuthToken]);

  useEffect(() => { void load(); }, [load]);

  const remove = async (c: Cred) => {
    setError(null);
    const token = getAuthToken();
    const r = await fetch(`/api/account/credentials/${c.kind}/${encodeURIComponent(c.value)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) {
      const code = ((await r.json().catch(() => ({}))) as { error?: string }).error;
      setError(code === 'last_credential' ? 'You need at least one way to sign in.' : code === 'farcaster_unlink_unsupported' ? 'Farcaster cannot be removed yet.' : 'Could not remove it.');
      return;
    }
    await load();
  };

  if (!creds) return null;
  const has = (k: Cred['kind']) => creds.some(c => c.kind === k);

  return (
    <section className="settings-section">
      <div className="settings-section-header">
        <KeyRound size={18} />
        <h2>Sign-in methods</h2>
      </div>
      <p className="settings-section-description">
        Every way to sign in to this qbase account. Your answers belong to the account, not to any one of these.
      </p>
      <ul className="sign-in-methods">
        {creds.map(c => (
          <li key={c.id} className="sign-in-method">
            <span className="sign-in-method-kind">{KIND_LABEL[c.kind]}</span>
            <span className="sign-in-method-value">{describe(c)}</span>
            {c.kind !== 'farcaster' && creds.length > 1 && (
              <button className="sign-in-method-remove" onClick={() => { void remove(c); }}>Remove</button>
            )}
          </li>
        ))}
      </ul>
      <div className="sign-in-method-actions">
        {accountMethods.ethereum && (
          <button disabled={accountAuthBusy} onClick={async () => { await linkEthereum(); await load(); }}>Link an Ethereum wallet</button>
        )}
        {accountMethods.world && !has('world') && (
          <button disabled={accountAuthBusy} onClick={() => { void linkWorld(); }}>Link World ID</button>
        )}
      </div>
      {(error || accountAuthError) && <p className="settings-section-description">{error ?? accountAuthError}</p>}
    </section>
  );
};

export default SignInMethods;
