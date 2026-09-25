/**
 * useAccountAuth — the non-Farcaster sign-in methods (docs/specs/account-root.md §6.2–6.3):
 * Sign-In with Ethereum (an injected wallet; the ENS name is shown, the
 * address is the credential) and World ID (a redirect to the World IdP).
 *
 * Both are live only after the server-side account cutover; `methods` says
 * which the server offers right now.
 */
import { useCallback, useEffect, useState } from 'react';
import { connect, getConnections, signMessage } from '@wagmi/core';
import { injected } from 'wagmi/connectors';
import { createSiweMessage } from 'viem/siwe';
import { wagmiConfig } from '../../lib/wagmi';
import type { User } from './types';

export interface AccountMethods { ethereum: boolean; world: boolean }

interface Deps {
  isMiniApp: boolean;
  setUser: (user: User) => void;
  fetchOwnProfile?: (token: string) => Promise<void> | void;
}

export interface AccountAuthHook {
  methods: AccountMethods;
  busy: boolean;
  error: string | null;
  /** Resolves true when signed in. */
  loginWithEthereum: () => Promise<boolean>;
  loginWithWorld: () => Promise<void>;
  /** Link a wallet to the signed-in account (Settings → Sign-in methods). */
  linkEthereum: (sessionToken: string) => Promise<void>;
  linkWorld: (sessionToken: string) => Promise<void>;
}

const ERRORS: Record<string, string> = {
  accounts_not_ready: 'This sign-in method is not available yet.',
  nonce_expired: 'That sign-in request expired. Try again.',
  bad_signature: 'The signature did not match the wallet.',
  credential_in_use: 'That sign-in method already belongs to another qbase account.',
  world_login_unconfigured: 'World ID sign-in is not available yet.',
};
const message = (code: string) => ERRORS[code] ?? 'Sign-in failed. Try again.';

async function walletAddress(): Promise<`0x${string}`> {
  const existing = getConnections(wagmiConfig).find(c => c.accounts.length > 0);
  if (existing) return existing.accounts[0];
  const r = await connect(wagmiConfig, { connector: injected() });
  return r.accounts[0];
}

async function signIn(address: `0x${string}`) {
  const { nonce } = await fetch('/api/auth/siwe/nonce').then(r => r.json() as Promise<{ nonce?: string; error?: string }>);
  if (!nonce) throw new Error('accounts_not_ready');
  const msg = createSiweMessage({
    address, chainId: 1, domain: window.location.host, nonce, uri: window.location.origin, version: '1',
    statement: 'Sign in to qbase', issuedAt: new Date(), expirationTime: new Date(Date.now() + 5 * 60_000),
  });
  const signature = await signMessage(wagmiConfig, { message: msg, account: address });
  return { message: msg, signature };
}

export function useAccountAuth({ isMiniApp, setUser, fetchOwnProfile }: Deps): AccountAuthHook {
  const [methods, setMethods] = useState<AccountMethods>({ ethereum: false, world: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isMiniApp) return;
    fetch('/api/auth/methods').then(r => (r.ok ? r.json() : null)).then(m => { if (m) setMethods(m as AccountMethods); }).catch(() => {});
  }, [isMiniApp]);

  const adopt = useCallback(async (sessionToken: string, accountId: number, label: string | null) => {
    // accountId itself comes from /api/users/me (AuthContext's identity fetch).
    setUser({ sessionToken, username: label ?? undefined, displayName: label ?? undefined, profileSource: 'native', pfpUrl: `https://api.dicebear.com/7.x/identicon/svg?seed=${accountId}` });
    await fetchOwnProfile?.(sessionToken);
  }, [setUser, fetchOwnProfile]);

  // Back from the World IdP: #qbase_session=… or #auth_error=…
  useEffect(() => {
    if (isMiniApp || typeof window === 'undefined' || !window.location.hash) return;
    const h = new URLSearchParams(window.location.hash.slice(1));
    const token = h.get('qbase_session');
    const err = h.get('auth_error');
    if (!token && !err && !h.get('linked')) return;
    history.replaceState(null, '', window.location.pathname + window.location.search);
    if (err) { setError(message(err)); return; }
    if (token) {
      fetch('/api/users/me', { headers: { Authorization: `Bearer ${token}` } })
        .then(r => (r.ok ? r.json() : null))
        .then((me: { account_id?: number; fname?: string } | null) => adopt(token, Number(me?.account_id), me?.fname ?? 'World ID'))
        .catch(() => setError(message('internal')));
    }
  }, [isMiniApp, adopt]);

  const loginWithEthereum = useCallback(async () => {
    setBusy(true); setError(null);
    try {
      const body = await signIn(await walletAddress());
      const r = await fetch('/api/auth/siwe/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json() as { sessionToken?: string; accountId?: number; ensName?: string | null; address?: string; error?: string };
      if (!r.ok || !j.sessionToken || !j.accountId) throw new Error(j.error ?? 'failed');
      await adopt(j.sessionToken, j.accountId, j.ensName ?? (j.address ? `${j.address.slice(0, 6)}…${j.address.slice(-4)}` : null));
      return true;
    } catch (e) {
      setError(message(e instanceof Error ? e.message : 'failed'));
      return false;
    } finally {
      setBusy(false);
    }
  }, [adopt]);

  const startWorld = useCallback(async (sessionToken?: string) => {
    setBusy(true); setError(null);
    try {
      const r = await fetch('/api/auth/world/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}) },
        body: JSON.stringify({ link: !!sessionToken, returnTo: sessionToken ? '/settings' : window.location.pathname }),
      });
      const j = await r.json() as { url?: string; error?: string };
      if (!r.ok || !j.url) throw new Error(j.error ?? 'failed');
      window.location.assign(j.url);
    } catch (e) {
      setError(message(e instanceof Error ? e.message : 'failed'));
      setBusy(false);
    }
  }, []);

  const linkEthereum = useCallback(async (sessionToken: string) => {
    setBusy(true); setError(null);
    try {
      const body = await signIn(await walletAddress());
      const r = await fetch('/api/auth/siwe/verify', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionToken}` },
        body: JSON.stringify({ ...body, link: true }),
      });
      const j = await r.json() as { error?: string };
      if (!r.ok) throw new Error(j.error ?? 'failed');
    } catch (e) {
      setError(message(e instanceof Error ? e.message : 'failed'));
    } finally {
      setBusy(false);
    }
  }, []);

  return {
    methods, busy, error,
    loginWithEthereum,
    loginWithWorld: () => startWorld(),
    linkEthereum,
    linkWorld: (t: string) => startWorld(t),
  };
}
