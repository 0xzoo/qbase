/**
 * CouncilPanel — the question's Council thread: each model's answer per round,
 * and the button that summons them (paid). Mounted only where the typology
 * says a model can answer (`councilApplies`: world-referent or request) and
 * only once the council is open (priced) or a thread already exists — so
 * until payment ships nothing shows anywhere. Viewing is free; asking again is
 * a new paid round. Same panel is the request-thread surface for
 * `intent = request` questions. Spec: docs/specs/paid-council.md.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2, Sparkles, ExternalLink } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { councilApplies } from '../lib/council';
import type { CouncilResponse, CouncilThread, Query } from '../lib/types';
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
  question: Query;
}

type Phase = 'idle' | 'summoning';

const CouncilPanel: React.FC<CouncilPanelProps> = ({ question }) => {
  // Cheap client-side pre-check; the server applies the same rule to the thread and to summons.
  const applies = councilApplies(question.taxonomy);
  if (!applies) return null;
  return <CouncilPanelInner questionId={question.id} />;
};

const CouncilPanelInner: React.FC<{ questionId: string }> = ({ questionId }) => {
  const { isAuthenticated, fid, getAuthToken, login } = useAuth();
  // Summons are keyed to the $QQ stake of a Farcaster fid (routes/council.ts).
  const needsFarcaster = isAuthenticated && fid == null;
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

  const summon = async (again = false) => {
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
        body: JSON.stringify({ again }),
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

  // Rounds: one per summon, newest first (the API orders by created_at desc); models in a stable order within a round.
  const rounds = useMemo(() => {
    const byRound = new Map<string, CouncilResponse[]>();
    for (const r of thread?.responses ?? []) {
      const list = byRound.get(r.summon_id) ?? [];
      list.push(r);
      byRound.set(r.summon_id, list);
    }
    return [...byRound.values()]
      .map(list => [...list].sort((a, b) => MODEL_ORDER.indexOf(a.model) - MODEL_ORDER.indexOf(b.model)))
      .sort((a, b) => b[0].created_at - a[0].created_at);
  }, [thread]);
  const config = thread?.config;
  const answered = rounds.length > 0;
  const open = !!config?.open;
  const priceLabel = config?.gated ? ` · ${Number(config.price).toLocaleString()} $QQ` : '';
  const canAskAgain = answered && open;

  // Nothing to show: still loading, the server says the council does not apply,
  // or it is closed and nobody has summoned it here.
  if (loading) return null;
  if (!thread || !thread.applies) return null;
  if (!open && !answered) return null;

  return (
    <section className="council-panel" aria-label="Council">
      <div className="council-header">
        <span className="council-title"><Sparkles size={14} /> Council</span>
        <span className="council-subtitle">three models answer as themselves</span>
      </div>

      {answered ? (
        <div className="council-thread">
          {rounds.map((round, i) => (
            <div className="council-round" key={round[0].summon_id}>
              {rounds.length > 1 && (
                <div className="council-round-label">
                  Round {rounds.length - i} · {relativeTime(round[0].created_at)}
                </div>
              )}
              {round.map(r => <ResponseCard key={r.id} r={r} />)}
            </div>
          ))}
        </div>
      ) : (
        <p className="council-empty">The council has not been summoned on this question.</p>
      )}

      {open && (!answered || canAskAgain) && (
        <div className="council-actions">
          {needsFarcaster ? (
            <p className="council-notice">
              Summoning the council needs a linked Farcaster account. <Link to="/settings">Link one in Settings</Link>
            </p>
          ) : phase === 'summoning' ? (
            <div className="council-deliberating">
              <Loader2 className="council-spin" size={16} /> The council is deliberating…
            </div>
          ) : (
            <button type="button" className="council-summon-btn" onClick={() => summon(answered)}>
              {!isAuthenticated
                ? 'Sign in to summon the council'
                : answered ? `Ask the council again${priceLabel}` : `Summon the council${priceLabel}`}
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
