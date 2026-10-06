/**
 * MyAccessPage — /me/access: who can read your answers, and what they read
 * (docs/specs/personal-mcp.md §3.4, consent-model.md §4).
 *
 * Lists the owner's grants (today: personal MCP keys for their own agents)
 * with each one's read log from grant_reads, mints a key (shown once), and
 * revokes. Revocation is forward-only and the copy says so. The consent copy
 * comes from the server (consent_copy) so the version shown is the one the
 * grant records.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Copy, KeyRound, Lock } from 'lucide-react';
import Header from '../components/Header';
import LoadingAnimation from '../components/LoadingAnimation';
import { useAuth } from '../context/AuthContext';
import { apiClient } from '../lib/apiClient';
import './MyQuizAnswersPage.css';
import '../components/MyQuestionAnswers.css';
import './MyAccessPage.css';

type Tier = 'Public' | 'Anon' | 'Secret';

interface GrantView {
  id: string;
  label: string | null;
  key_hint: string | null;
  ceiling: Tier;
  disclosure: 'raw' | 'derived';
  purpose: string | null;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
  expires_at: number | null;
  reads: { total: number; answers: number; last_at: number | null };
  recent: Array<{ tool: string; answer_count: number; max_tier: string | null; at: number }>;
}

const TIER_COPY: Record<Tier, string> = {
  Public: 'Public answers only',
  Anon: 'Public + your Anon answers (links them to you in the agent)',
  Secret: 'Everything: Public, Anon and Secret',
};

const when = (ms: number | null) => (ms ? new Date(ms).toLocaleString() : 'never');
const MCP_URL = `${window.location.origin}/mcp`;

export default function MyAccessPage() {
  const navigate = useNavigate();
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const [grants, setGrants] = useState<GrantView[] | null>(null);
  const [copyText, setCopyText] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [ceiling, setCeiling] = useState<Tier>('Public');
  const [disclosure, setDisclosure] = useState<'raw' | 'derived'>('raw');
  const [busy, setBusy] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiClient.get('/api/me/grants');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { grants: GrantView[]; copy?: { text: string } };
      setGrants(data.grants);
      setCopyText(data.copy?.text ?? '');
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (authLoading || !isAuthenticated) return;
    void load();
  }, [authLoading, isAuthenticated, load]);

  const create = async () => {
    setBusy(true);
    try {
      const res = await apiClient.post('/api/me/grants', { label: label.trim() || undefined, ceiling, disclosure });
      const data = (await res.json()) as { key?: string; error?: string };
      if (!res.ok || !data.key) throw new Error(data.error ?? `HTTP ${res.status}`);
      setNewKey(data.key);
      setLabel('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (g: GrantView) => {
    if (!window.confirm(`Revoke "${g.label ?? 'key'}"? It stops working now. Whatever it already read stays with that agent.`)) return;
    const res = await apiClient.delete(`/api/me/grants/${encodeURIComponent(g.id)}`);
    if (res.ok) await load();
  };

  if (!authLoading && !isAuthenticated) {
    return (
      <div className="mqa-page">
        <Header showBack closeButton onBack={() => navigate(-1)} title="access" />
        <div className="mqa-container">
          <div className="mqa-empty">
            <Lock size={40} />
            <h2>Sign in to manage access</h2>
          </div>
        </div>
      </div>
    );
  }

  const live = (grants ?? []).filter((g) => !g.revoked_at);
  const revoked = (grants ?? []).filter((g) => g.revoked_at);

  return (
    <div className="mqa-page">
      <Header showBack closeButton onBack={() => navigate(-1)} title="access" />
      <div className="mqa-container">
        <p className="mqa-intro">
          Keys let an AI agent you use (Claude, Hermes, anything that speaks MCP) read your answers so it can help you decide things.
          Every read is logged below. <strong>Agents can read, never answer for you.</strong>
        </p>
        <div className="mqa-links">
          <Link to="/me/answers">your answers →</Link>
        </div>

        <h2 className="mqa-section-title">new key</h2>
        <div className="acc-card">
          {copyText && <p className="acc-copy">{copyText}</p>}
          <label className="acc-field">
            <span>name</span>
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="claude code, hermes…" maxLength={80} />
          </label>
          <fieldset className="acc-field">
            <legend>it can read</legend>
            {(Object.keys(TIER_COPY) as Tier[]).map((t) => (
              <label key={t} className="acc-radio">
                <input type="radio" name="ceiling" checked={ceiling === t} onChange={() => setCeiling(t)} />
                {TIER_COPY[t]}
              </label>
            ))}
          </fieldset>
          <fieldset className="acc-field">
            <legend>as</legend>
            <label className="acc-radio">
              <input type="radio" name="disclosure" checked={disclosure === 'raw'} onChange={() => setDisclosure('raw')} />
              your answers, and your quiz results
            </label>
            <label className="acc-radio">
              <input type="radio" name="disclosure" checked={disclosure === 'derived'} onChange={() => setDisclosure('derived')} />
              quiz results and counts only, no answers
            </label>
          </fieldset>
          <button className="acc-button" disabled={busy} onClick={() => void create()}>
            <KeyRound size={16} /> create key
          </button>
        </div>

        {newKey && (
          <div className="acc-card acc-newkey">
            <p><strong>Copy this key now.</strong> qbase keeps only a fingerprint of it, so it can't be shown again.</p>
            <code className="acc-secret">{newKey}</code>
            <button className="acc-link" onClick={() => void navigator.clipboard.writeText(newKey)}><Copy size={14} /> copy</button>
            <p className="acc-hint">Endpoint <code>{MCP_URL}</code>, header <code>Authorization: Bearer &lt;key&gt;</code>. For Claude Code:</p>
            <code className="acc-secret">claude mcp add --transport http qbase {MCP_URL} --header "Authorization: Bearer {newKey}"</code>
            <button className="acc-link" onClick={() => setNewKey(null)}>done</button>
          </div>
        )}

        <h2 className="mqa-section-title">keys</h2>
        {error ? (
          <div className="mqa-error">Could not load access: {error}</div>
        ) : grants === null ? (
          <div className="mqa-loading"><LoadingAnimation variant="spinner" size="md" /></div>
        ) : live.length === 0 ? (
          <div className="mqa-empty"><p>No agent can read your answers.</p></div>
        ) : (
          live.map((g) => <GrantCard key={g.id} g={g} onRevoke={() => void revoke(g)} />)
        )}

        {revoked.length > 0 && (
          <>
            <h2 className="mqa-section-title">revoked</h2>
            {revoked.map((g) => <GrantCard key={g.id} g={g} />)}
          </>
        )}
      </div>
    </div>
  );
}

function GrantCard({ g, onRevoke }: { g: GrantView; onRevoke?: () => void }) {
  return (
    <div className={`acc-card${g.revoked_at ? ' acc-revoked' : ''}`}>
      <div className="acc-head">
        <strong>{g.label ?? 'unnamed key'}</strong>
        <span className="acc-meta">…{g.key_hint}</span>
      </div>
      <p className="acc-meta">
        reads {TIER_COPY[g.ceiling].toLowerCase()}{g.disclosure === 'derived' ? ', as quiz results and counts only' : ''} ·
        created {when(g.created_at)}{g.revoked_at ? ` · revoked ${when(g.revoked_at)}` : ''}
      </p>
      <p className="acc-meta">
        {g.reads.total} reads, {g.reads.answers} answers served · last {when(g.reads.last_at)}
      </p>
      {g.recent.length > 0 && (
        <ul className="acc-log">
          {g.recent.map((r, i) => (
            <li key={i}>
              <span>{new Date(r.at).toLocaleString()}</span>
              <span>{r.tool}</span>
              <span>{r.answer_count} answers{r.max_tier ? ` · up to ${r.max_tier}` : ''}</span>
            </li>
          ))}
        </ul>
      )}
      {onRevoke && <button className="acc-link acc-danger" onClick={onRevoke}>revoke</button>}
    </div>
  );
}
