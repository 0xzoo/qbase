/**
 * CouncilPanel — the question's Council thread: each model's answer, and the
 * button that summons them (paid from the viewer's $QQ stake when the gate is
 * on). Same panel is the request-thread surface for `intent = request`
 * questions. Spec: docs/specs/paid-council.md.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2, Sparkles, ExternalLink } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import type { CouncilResponse, CouncilThread } from '../lib/types';
import './OracleAnswerCard.css';
import './CouncilPanel.css';

const MODEL_LABELS: Record<string, string> = { qlaude: 'Claude', qemini: 'Gemini', chatqpt: 'ChatGPT' };
const MODEL_ACCENTS: Record<string, string> = { qlaude: '#8b5cf6', chatqpt: '#14b8a6', qemini: '#a78bfa' };
const MODEL_ORDER = ['qlaude', 'qemini', 'chatqpt'];

/** wei string → whole $QQ with separators (the panel never needs fractions). */
function formatQQ(wei: string | null | undefined): string {
  if (!wei) return '0';
  try {
    return (BigInt(wei) / 10n ** 18n).toLocaleString();
  } catch {
    return '0';
  }
}

function relativeTime(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return 'now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return `${Math.floor(d / 7)}w`;
}

const ResponseCard: React.FC<{ r: CouncilResponse }> = ({ r }) => (
  <div className="oracle-answer-card council-response" style={{ '--oracle-accent': MODEL_ACCENTS[r.model] ?? '#8b5cf6' } as React.CSSProperties}>
    <div className="oracle-answer-header">
      <div className="oracle-answer-model">
        <span className="oracle-model-name">{r.model}</span>
        <span className="council-model-full">{MODEL_LABELS[r.model] ?? 'AI model'}</span>
      </div>
      <div className="oracle-answer-badge">
        {r.model_id && <span className="oracle-badge-item" title="Model">{r.model_id.replace(/^.*\//, '').substring(0, 18)}</span>}
        <span className="oracle-badge-item" title="Answered">{relativeTime(r.created_at)}</span>
      </div>
    </div>
    <div className="oracle-answer-content">{r.text}</div>
    {r.cast_hash && (
      <a
        className="council-cast-link"
        href={`https://farcaster.xyz/~/conversations/${r.cast_hash}`}
        target="_blank"
        rel="noopener noreferrer"
      >
        View on Farcaster <ExternalLink size={12} />
      </a>
    )}
  </div>
);

interface CouncilPanelProps {
  questionId: string;
}

type Phase = 'idle' | 'summoning';

const CouncilPanel: React.FC<CouncilPanelProps> = ({ questionId }) => {
  const { isAuthenticated, getAuthToken, login } = useAuth();
  const [thread, setThread] = useState<CouncilThread | null>(null);
  const [loading, setLoading] = useState(true);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [stakeShortfall, setStakeShortfall] = useState<{ price: string; balance: string } | null>(null);

  const authHeaders = useCallback((): Record<string, string> => {
    const token = getAuthToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }, [getAuthToken]);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/queries/${questionId}/council`, { headers: authHeaders() });
      if (!res.ok) throw new Error(`council ${res.status}`);
      setThread(await res.json() as CouncilThread);
    } catch (e) {
      console.warn('[CouncilPanel] load failed', e);
    } finally {
      setLoading(false);
    }
  }, [questionId, authHeaders]);

  useEffect(() => { void load(); }, [load]);

  const summon = async () => {
    if (!isAuthenticated) {
      login();
      return;
    }
    setPhase('summoning');
    setError(null);
    setStakeShortfall(null);
    try {
      const res = await fetch(`/api/queries/${questionId}/council`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
      });
      const body = await res.json().catch(() => ({})) as Record<string, unknown>;
      if (res.status === 402) {
        setStakeShortfall({ price: String(body.price ?? ''), balance: String(body.balance ?? '0') });
        return;
      }
      if (!res.ok) {
        setError(String(body.error ?? `The council could not be summoned (${res.status})`));
        return;
      }
      setThread(t => t ? { ...t, responses: (body.responses as CouncilResponse[]) ?? t.responses } : t);
      void load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The council could not be summoned');
    } finally {
      setPhase('idle');
    }
  };

  const responses = [...(thread?.responses ?? [])].sort(
    (a, b) => MODEL_ORDER.indexOf(a.model) - MODEL_ORDER.indexOf(b.model),
  );
  const config = thread?.config;
  const answered = responses.length > 0;
  const priceLabel = config?.gated ? ` · ${Number(config.price).toLocaleString()} $QQ` : '';

  return (
    <section className="council-panel" aria-label="Council">
      <div className="council-header">
        <span className="council-title"><Sparkles size={14} /> Council</span>
        <span className="council-subtitle">three models answer as themselves</span>
      </div>

      {loading ? (
        <div className="council-loading"><Loader2 className="council-spin" size={16} /></div>
      ) : answered ? (
        <div className="council-thread">
          {responses.map(r => <ResponseCard key={r.id} r={r} />)}
        </div>
      ) : (
        <p className="council-empty">The council has not been summoned on this question.</p>
      )}

      {!loading && !answered && (
        <div className="council-actions">
          {phase === 'summoning' ? (
            <div className="council-deliberating">
              <Loader2 className="council-spin" size={16} /> The council is deliberating…
            </div>
          ) : (
            <button type="button" className="council-summon-btn" onClick={summon}>
              {isAuthenticated ? `Summon the council${priceLabel}` : 'Sign in to summon the council'}
            </button>
          )}
          {stakeShortfall && (
            <p className="council-notice">
              Summoning costs {Number(stakeShortfall.price).toLocaleString()} $QQ from your stake; you have {formatQQ(stakeShortfall.balance)}.{' '}
              <Link to={config?.stake_url ?? '/stake'}>Stake $QQ</Link>
            </p>
          )}
          {!stakeShortfall && config?.gated && thread?.viewer && !thread.viewer.can_summon && (
            <p className="council-notice">
              Costs {Number(config.price).toLocaleString()} $QQ from your stake.{' '}
              <Link to={config.stake_url}>Stake $QQ</Link>
            </p>
          )}
          {error && <p className="council-error">{error}</p>}
        </div>
      )}
    </section>
  );
};

export default CouncilPanel;
