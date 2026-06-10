/**
 * /apperception/result — mini-app result page.
 *
 * Loads session via /api/apperception/session?sid=X (Quick Auth) and shows:
 *   - 3D cube (drag to rotate) + diverging meters
 *   - Style badge with confidence band
 *   - Summary paragraph
 *   - Signature answers
 *   - $QQ-gated: all-styles breakdown + dimension analysis
 *   - Airdrop status badge
 *   - Rating prompt
 */

import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { sdk } from '@farcaster/miniapp-sdk';
import { Loader2, AlertCircle, ThumbsUp, ThumbsDown, Lock } from 'lucide-react';
import Header from '../components/Header';
import ApperceptionCube from '../components/ApperceptionCube';
import ApperceptionMeters from '../components/ApperceptionMeters';
import { GetQQModal } from '../components/GetQQModal';
import './ApperceptionResult.css';

type ApperceptionAxis = 'concrete' | 'reflective' | 'sequential';

interface ApperceptionScore {
  concrete: number;
  reflective: number;
  sequential: number;
  confidence: number;
}

interface StyleResult {
  style: string;
  blended: boolean;
  confidence: 'strong' | 'moderate' | 'mild';
}

interface FreeResult {
  scores: ApperceptionScore;
  style: StyleResult;
  summary: string;
  signatureAnswers: string[];
}

interface GatedResult extends FreeResult {
  ranked: ApperceptionAxis[];
  allStyles: Array<{ name: string; match: number }>;
  styleBreakdown: string;
}

interface SessionInfo {
  id: string;
  fid: number;
  index: number;
  total: number;
  completed: boolean;
  createdAt: number;
  rated: boolean;
}

interface QQGateState {
  unlocked: boolean;
  balance: string;   // wei
  threshold: string; // wei
  address: string | null;
  inspected?: Array<{ address: string; balance: string }>;
  rpcError?: boolean;
}

type AirdropStatus =
  | 'success'
  | 'already_claimed'
  | 'pool_exhausted'
  | 'not_eligible'
  | 'disabled'
  | 'error'
  | 'pending';

interface AirdropInfo {
  status: AirdropStatus;
  txHash: string | null;
  amountTokens?: string | null;
}

type Phase = 'loading' | 'incomplete' | 'result' | 'error';

const dimLabels: Record<ApperceptionAxis, string> = {
  concrete: 'concrete',
  reflective: 'reflective',
  sequential: 'sequential',
};

const dimAxisLabel: Record<ApperceptionAxis, string> = {
  concrete: 'concrete ↔ abstract',
  reflective: 'reflective ↔ active',
  sequential: 'sequential ↔ integrative',
};

const poleLabels: Record<ApperceptionAxis, { high: string; low: string }> = {
  concrete: { high: 'example-first', low: 'principle-first' },
  reflective: { high: 'think-before-acting', low: 'learn-by-doing' },
  sequential: { high: 'step-by-step', low: 'big-picture-first' },
};

const DIMS: ApperceptionAxis[] = ['concrete', 'reflective', 'sequential'];

const confidenceColor: Record<string, string> = {
  strong: 'var(--color-green)',
  moderate: 'var(--color-amber)',
  mild: 'var(--color-slate)',
};

// 4.42M = vault per-distribute cap, matches bartlet + values.
const QQ_THRESHOLD_DISPLAY = '4.42M';

function formatQQ(wei: string): string {
  try {
    const n = BigInt(wei);
    const whole = n / 10n ** 18n;
    if (whole >= 1_000_000n) return `${(Number(whole) / 1_000_000).toFixed(2)}M`;
    if (whole >= 1_000n) return `${(Number(whole) / 1_000).toFixed(1)}K`;
    return whole.toString();
  } catch {
    return '0';
  }
}

export default function ApperceptionResult() {
  const [searchParams] = useSearchParams();
  const sid = searchParams.get('sid');

  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState<string | null>(null);
  const [free, setFree] = useState<FreeResult | null>(null);
  const [gated, setGated] = useState<GatedResult | null>(null);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [gate, setGate] = useState<QQGateState | null>(null);
  const [airdrop, setAirdrop] = useState<AirdropInfo | null>(null);
  const [rated, setRated] = useState(false);
  const [dimContent, setDimContent] = useState<Record<string, { summary: string; blindSpot: string }> | null>(null);
  // dimSource ('llm' | 'static') is tracked for a future provenance badge; only the setter is used today
  const [_dimSource, setDimSource] = useState<'llm' | 'static' | null>(null);
  const [dimLoading, setDimLoading] = useState(false);
  const [dimError, setDimError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    if (!sid) {
      setError('Missing session ID');
      setPhase('error');
      return;
    }

    let cancelled = false;

    async function load() {
      try {
        const { token: t } = await sdk.quickAuth.getToken();
        setToken(t);
        const res = await fetch(`/api/apperception/session?sid=${encodeURIComponent(sid)}`, {
          headers: { Authorization: `Bearer ${t}` },
        });

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error((body as { error?: string }).error || `HTTP ${res.status}`);
        }

        const data = await res.json();
        if (cancelled) return;

        if (!data.session.completed) {
          setSession(data.session);
          setPhase('incomplete');
          return;
        }

        setSession(data.session);
        setFree(data.free);
        setGated(data.gated);
        setGate(data.gate ?? null);
        setAirdrop(data.airdrop ?? null);
        setRated(data.session.rated);
        setPhase('result');
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load result');
          setPhase('error');
        }
      }
    }

    load();
    return () => { cancelled = true; };
  }, [sid]);

  // Phase-2: load dim narratives when gate unlocks.
  useEffect(() => {
    if (!sid || !token) return;
    const unlocked = gate?.unlocked ?? false;
    if (!unlocked) return;
    if (dimContent !== null) return; // already loaded
    if (dimLoading) return;

    let cancelled = false;

    async function loadDim() {
      setDimLoading(true);
      try {
        const res = await fetch(`/api/apperception/dim-narratives?sid=${encodeURIComponent(sid)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (cancelled) return;

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setDimError((body as { error?: string }).error || `HTTP ${res.status}`);
          return;
        }

        const data = await res.json();
        if (cancelled) return;
        setDimContent(data.dimContent as Record<string, { summary: string; blindSpot: string }>);
        setDimSource(data.source as 'llm' | 'static');
        if (data.error) setDimError(data.error);
      } catch (err) {
        if (!cancelled) {
          setDimError(err instanceof Error ? err.message : 'Failed');
        }
      } finally {
        if (!cancelled) setDimLoading(false);
      }
    }

    loadDim();
    return () => { cancelled = true; };
  }, [sid, token, gate, dimContent, dimLoading]);

  async function handleRate(rating: 'up' | 'down') {
    try {
      const { token } = await sdk.quickAuth.getToken();
      await fetch(`/api/apperception/rate?sid=${encodeURIComponent(sid!)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ rating }),
      });
      setRated(true);
    } catch { /* best-effort */ }
  }

  // ── Loading ──
  if (phase === 'loading') {
    return (
      <>
        <Header />
        <div className="result-page result-center">
          <Loader2 className="spinner" />
          <p>Loading your result…</p>
        </div>
      </>
    );
  }

  // ── Incomplete ──
  if (phase === 'incomplete' && session) {
    return (
      <>
        <Header />
        <div className="result-page result-center">
          <AlertCircle />
          <h2>Quiz not complete</h2>
          <p>
            You've answered {session.index} of {session.total} questions.
            Go back to Farcaster and finish the quiz to see your result.
          </p>
        </div>
      </>
    );
  }

  // ── Error ──
  if (phase === 'error') {
    return (
      <>
        <Header />
        <div className="result-page result-center">
          <AlertCircle />
          <h2>Something went wrong</h2>
          <p>{error}</p>
        </div>
      </>
    );
  }

  // ── Result ──
  if (!free) return null;

  const style = free.style;
  const unlocked = gate?.unlocked ?? false;

  return (
    <>
      <Header />
      <div className="result-page result-container">
        <h1 className="result-title">apperception</h1>

        {/* 3D cube (drag to rotate) + diverging meters */}
        <div
          className="radar-section"
          style={{ display: 'flex', flexWrap: 'wrap', gap: 24, alignItems: 'center', justifyContent: 'center' }}
        >
          <div style={{ flex: '1 1 260px', minWidth: 240, maxWidth: 360 }}>
            <ApperceptionCube scores={free.scores} />
            <p style={{ textAlign: 'center', fontSize: 12, color: '#94A3B8', margin: '4px 0 0' }}>
              drag to rotate
            </p>
          </div>
          <div style={{ flex: '1 1 260px', minWidth: 240, maxWidth: 380 }}>
            <ApperceptionMeters scores={free.scores} />
          </div>
        </div>

        {/* Badge */}
        <div className="badge-section">
          <span className="style-badge">{style.blended ? `Leaning ${style.style}` : style.style}</span>
          <span className="confidence-text" style={{ color: confidenceColor[style.confidence] }}>
            {style.confidence} fit
          </span>
        </div>

        {/* Airdrop badge */}
        {airdrop && <AirdropBadge airdrop={airdrop} />}

        {/* Summary */}
        <p className="summary-text">{free.summary}</p>

        {/* Signature answers */}
        {free.signatureAnswers.length > 0 && (
          <div className="signature-section">
            <h3>signature answers</h3>
            <ul>
              {free.signatureAnswers.map((a, i) => (
                <li key={i}>{a}</li>
              ))}
            </ul>
          </div>
        )}

        {/* Gated: all styles breakdown (behind $QQ gate) */}
        {unlocked && gated && gated.allStyles.length > 0 && (
          <UnlockedPanel
            gated={gated}
            style={style}
            scores={free.scores}
            dimContent={dimContent}
            dimLoading={dimLoading}
            dimError={dimError}
          />
        )}

        {!unlocked && (
          <LockedPanel gate={gate} />
        )}

        {/* Rating */}
        {!rated && (
          <div className="rating-section">
            <p>Did this feel accurate?</p>
            <div className="rating-buttons">
              <button className="rating-btn" onClick={() => handleRate('up')}>
                <ThumbsUp size={18} />
              </button>
              <button className="rating-btn" onClick={() => handleRate('down')}>
                <ThumbsDown size={18} />
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

// ─── Airdrop badge ─────────────────────────────────────────────────────────

const AirdropBadge: React.FC<{ airdrop: AirdropInfo }> = ({ airdrop }) => {
  const explorer = (h: string) => `https://basescan.org/tx/${h}`;
  const amount = airdrop.amountTokens
    ? `${(Number(airdrop.amountTokens) / 1_000_000).toFixed(2)}M`
    : QQ_THRESHOLD_DISPLAY;
  switch (airdrop.status) {
    case 'success':
    case 'already_claimed':
      return (
        <div className="apperception-airdrop apperception-airdrop--ok">
          ✓ {amount} $QQ airdropped
          {airdrop.txHash && (
            <>
              {' · '}
              <a href={explorer(airdrop.txHash)} target="_blank" rel="noopener noreferrer">
                tx
              </a>
            </>
          )}
        </div>
      );
    case 'pool_exhausted':
      return (
        <div className="apperception-airdrop">
          airdrop pool exhausted — first 1000 completions claimed it.
        </div>
      );
    case 'not_eligible':
      return (
        <div className="apperception-airdrop">
          airdrop skipped — neynar score below 0.9 threshold.
        </div>
      );
    case 'error':
    case 'disabled':
    case 'pending':
      return (
        <div className="apperception-airdrop">
          airdrop pending — refresh the page to retry.
        </div>
      );
  }
};

// ─── Locked panel ──────────────────────────────────────────────────────────

const LockedPanel: React.FC<{ gate: QQGateState | null }> = ({ gate }) => {
  const [modalOpen, setModalOpen] = useState(false);
  const balance = gate ? formatQQ(gate.balance) : '0';

  return (
    <section className="apperception-gated">
      <div className="apperception-gated-header">
        <Lock size={16} />
        <span>all styles breakdown</span>
      </div>
      <p>
        hold ≥{QQ_THRESHOLD_DISPLAY} $QQ on Base to unlock a full breakdown of
        all 8 cognitive styles and your exact dimension scores.
      </p>
      <p className="apperception-gated-balance">your balance: {balance} $QQ</p>
      {gate?.rpcError && (
        <p className="apperception-gated-balance">
          balance lookup failed — refresh the page to retry.
        </p>
      )}
      {gate?.inspected && gate.inspected.length > 0 && (
        <details className="apperception-gated-debug">
          <summary>checked {gate.inspected.length} wallet
            {gate.inspected.length === 1 ? '' : 's'}</summary>
          <ul>
            {gate.inspected.map((row) => (
              <li key={row.address}>
                <code>{row.address.slice(0, 6)}…{row.address.slice(-4)}</code>{' '}
                {row.balance === 'error'
                  ? '(lookup failed)'
                  : `${formatQQ(row.balance)} $QQ`}
              </li>
            ))}
          </ul>
        </details>
      )}
      <button
        className="apperception-btn apperception-btn--secondary"
        onClick={() => setModalOpen(true)}
      >
        get $QQ
      </button>
      <GetQQModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        contextLine={`hold ≥${QQ_THRESHOLD_DISPLAY} $QQ to unlock the breakdown`}
      />
    </section>
  );
};

// ─── Unlocked panel ────────────────────────────────────────────────────────

const UnlockedPanel: React.FC<{
  gated: GatedResult;
  style: StyleResult;
  scores: ApperceptionScore;
  dimContent: Record<string, { summary: string; blindSpot: string }> | null;
  dimLoading: boolean;
  dimError: string | null;
}> = ({ gated, style, scores, dimContent, dimLoading, dimError }) => {
  return (
    <div className="gated-section">
      <h3>all styles</h3>
      <div className="styles-grid">
        {gated.allStyles.map((s) => (
          <div
            key={s.name}
            className={`style-row ${s.name === style.style ? 'active' : ''}`}
            style={{ ['--match' as string]: `${s.match}%` }}
          >
            <span className="style-name">{s.name}</span>
            <span className="style-match">{s.match}%</span>
          </div>
        ))}
      </div>

      <h3>dimensions</h3>
      <ul className="dim-list">
        {DIMS.map((d) => {
          const high = (gated.scores[d] ?? 0) > 0.5;
          const pole = high ? poleLabels[d].high : poleLabels[d].low;
          const pct = Math.round(Math.abs((gated.scores[d] ?? 0.5) - 0.5) * 2 * 100);
          return (
            <li key={d} className="dim-row">
              <span className="dim-axis">{dimAxisLabel[d]}</span>
              <span className="dim-lean">
                leans <strong>{pole}</strong> <span className="dim-pct">· {pct}%</span>
              </span>
            </li>
          );
        })}
      </ul>

      {/* Personalized narratives (phase-2) */}
      {dimLoading && (
        <div className="narrative-loading">
          <Loader2 className="spinner" size={14} />
          <span>generating personal narratives…</span>
        </div>
      )}

      {!dimLoading && dimError && (
        <p className="narrative-error">narratives: {dimError}</p>
      )}

      {!dimLoading && dimContent && (
        <div className="narrative-section">
          <h3>personal narratives</h3>
          {DIMS.map((d) => {
            const entry = dimContent[d];
            if (!entry) return null;
            const high = scores[d] > 0.5;
            const pole = high ? poleLabels[d].high : poleLabels[d].low;
            return (
              <div key={d} className="narrative-card">
                <div className="narrative-card-header">{dimLabels[d]} · leans {pole}</div>
                <p className="narrative-summary">{entry.summary}</p>
                <p className="narrative-blindspot">
                  <em>blind spot:</em> {entry.blindSpot}
                </p>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
