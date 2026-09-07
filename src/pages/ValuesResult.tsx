/**
 * /values/result — mini-app result page for the values quiz.
 *
 * Loads the session via /api/values/session?sid=X (auth required) and renders
 * the free tier: dominant badge, runner-up, 5-spoke radar, summary paragraph,
 * signature answers, share button. The gated tier (per-dim narratives, context
 * card export) is a placeholder card that links to "hold ≥4.42M $QQ on Base"
 * — task #6 wires the live balance check; task #7 builds the export.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { sdk } from '@farcaster/miniapp-sdk';
import { Loader2, AlertCircle, Lock } from 'lucide-react';
import { GetQQModal } from '../components/GetQQModal';
import Header from '../components/Header';
import ValuesRadar from '../components/ValuesRadar';
import { SPOKE_ORDER } from '../lib/valuesDims';
import './ValuesResult.css';

type ValuesAxis = 'autonomy' | 'care' | 'openness' | 'mastery' | 'universalism';

interface ValuesScore {
  autonomy: number;
  care: number;
  openness: number;
  mastery: number;
  universalism: number;
  confidence: number;
}

interface FreeResult {
  scores: ValuesScore;
  dominant: ValuesAxis;
  secondary: ValuesAxis;
  badge: string;
  summary: string;
  signatureAnswers: string[];
}

interface SessionInfo {
  id: string;
  fid: number;
  index: number;
  total: number;
  completed: boolean;
  createdAt: number;
}

type Phase = 'loading' | 'incomplete' | 'result' | 'error';

interface GateState {
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
  amountTokens: string | null;
}

type DimContent = Record<ValuesAxis, { summary: string; blindSpot: string }>;

const DIM_LABEL: Record<ValuesAxis, string> = {
  autonomy: 'Autonomy',
  care: 'Care',
  openness: 'Openness',
  mastery: 'Mastery',
  universalism: 'Universalism',
};

// Format wei → display string with 18 decimals truncated. Roughly: "4.42M".
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

const ValuesResult: React.FC = () => {
  const [searchParams] = useSearchParams();
  const sid = searchParams.get('sid');

  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [result, setResult] = useState<FreeResult | null>(null);
  const [gated, setGated] = useState<GateState | null>(null);
  const [dimContent, setDimContent] = useState<DimContent | null>(null);
  const [dimFallback, setDimFallback] = useState<{ error: string | null } | null>(null);
  const [airdrop, setAirdrop] = useState<AirdropInfo | null>(null);

  const loadSession = useCallback(async () => {
    if (!sid) {
      setError('Missing session ID');
      setPhase('error');
      return;
    }
    try {
      setPhase('loading');
      const res = await sdk.quickAuth.fetch(
        `/api/values/session?sid=${encodeURIComponent(sid)}`,
      );
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const body = (await res.json()) as {
        session: SessionInfo;
        result: FreeResult | null;
        gated: GateState | null;
        airdrop: AirdropInfo | null;
      };
      setSession(body.session);
      setGated(body.gated);
      setAirdrop(body.airdrop);
      if (body.session.completed && body.result) {
        setResult(body.result);
        setPhase('result');
      } else {
        setPhase('incomplete');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load session');
      setPhase('error');
    }
  }, [sid]);

  useEffect(() => {
    loadSession();
  }, [loadSession]);

  // Phase-2 fetch: dim narratives. Kicks in once we have the session + the
  // gate result. Separate endpoint so the Gemma call doesn't block the free
  // tier from painting.
  useEffect(() => {
    if (!sid || !gated?.unlocked) return;
    let cancelled = false;
    sdk.quickAuth
      .fetch(`/api/values/dim-narratives?sid=${encodeURIComponent(sid)}`)
      .then(async (res) => {
        if (!res.ok) {
          if (!cancelled) setDimContent(null);
          return;
        }
        const body = (await res.json()) as {
          dimContent: DimContent | null;
          source: 'llm' | 'static' | null;
          error: string | null;
        };
        if (cancelled) return;
        setDimContent(body.dimContent);
        setDimFallback(body.source === 'static' ? { error: body.error } : null);
      })
      .catch(() => {
        if (!cancelled) setDimContent(null);
      });
    return () => {
      cancelled = true;
    };
  }, [sid, gated?.unlocked]);

  const handleShare = useCallback(async () => {
    if (!result || !session) return;
    const shareUrl = `${window.location.origin}/snap/values?share=${encodeURIComponent(result.dominant)}&sid=${encodeURIComponent(session.id)}`;
    try {
      await sdk.actions.composeCast({
        text: `i'm ${DIM_LABEL[result.dominant].toLowerCase()}-led on the values quiz by @qbase — what are you?`,
        embeds: [shareUrl],
      });
    } catch {
      // Outside the miniapp context: copy share URL to clipboard as fallback.
      try {
        await navigator.clipboard.writeText(shareUrl);
      } catch {
        // No clipboard either — silent failure.
      }
    }
  }, [result, session]);

  if (phase === 'loading') {
    return (
      <>
        <Header title="values" />
        <div className="values-result values-result--center">
          <Loader2 className="values-spin" size={32} />
          <p>loading your result…</p>
        </div>
      </>
    );
  }

  if (phase === 'error') {
    return (
      <>
        <Header title="values" />
        <div className="values-result values-result--center">
          <AlertCircle size={32} />
          <p>{error || 'something went wrong'}</p>
        </div>
      </>
    );
  }

  if (phase === 'incomplete' && session) {
    const remaining = session.total - session.index;
    return (
      <>
        <Header title="values" />
        <div className="values-result values-result--center">
          <h2>quiz in progress</h2>
          <p>
            you've answered {session.index} of {session.total} — {remaining} to go.
          </p>
          <a className="values-btn values-btn--primary" href={`/snap/values?sid=${encodeURIComponent(session.id)}`}>
            continue
          </a>
        </div>
      </>
    );
  }

  if (!result) return null;

  return (
    <>
    <Header title="values" />
    <div className="values-result">
      <header className="values-header">
        <div className="values-badge">{result.badge.toUpperCase()}</div>
        <p className="values-secondary">secondary: {DIM_LABEL[result.secondary].toLowerCase()}</p>
      </header>

      <ValuesRadar scores={result.scores} />

      {airdrop && <AirdropBadge airdrop={airdrop} />}

      <section className="values-summary">
        <p>{result.summary}</p>
      </section>

      {result.signatureAnswers.length > 0 && (
        <section className="values-signatures">
          <h3>signature answers</h3>
          <ul>
            {result.signatureAnswers.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </section>
      )}

      <section className="values-actions">
        <button className="values-btn values-btn--primary" onClick={handleShare}>
          share
        </button>
        <Link className="values-btn values-btn--secondary" to="/values/compare">
          compare with a friend
        </Link>
      </section>

      {gated?.unlocked ? (
        dimContent ? (
          <UnlockedPanel
            dimContent={dimContent}
            ranked={SPOKE_ORDER.slice().sort(
              (a, b) => result.scores[b] - result.scores[a],
            )}
            fallback={dimFallback}
          />
        ) : (
          <section className="values-unlocked values-unlocked--loading">
            <Loader2 className="values-spin" size={18} />
            <span>generating your breakdown…</span>
          </section>
        )
      ) : (
        <LockedPanel gated={gated} onSwapSuccess={loadSession} />
      )}
    </div>
    </>
  );
};

// ─── Gated panels ────────────────────────────────────────────────────────

const LockedPanel: React.FC<{
  gated: GateState | null;
  onSwapSuccess?: () => void;
}> = ({ gated, onSwapSuccess }) => {
  const [modalOpen, setModalOpen] = useState(false);
  const balance = gated ? formatQQ(gated.balance) : '0';
  const threshold = gated ? formatQQ(gated.threshold) : '4.42M';

  // Tx submission doesn't immediately update on-chain balance — give it
  // ~15s to mine + index, then refetch the session so the gate flips. If
  // still locked at that point the user can refresh manually.
  const handleSuccess = useCallback(() => {
    if (!onSwapSuccess) return;
    setTimeout(() => onSwapSuccess(), 15_000);
  }, [onSwapSuccess]);

  return (
    <section className="values-gated">
      <div className="values-gated-header">
        <Lock size={16} />
        <span>per-dimension breakdown</span>
      </div>
      <p>
        hold ≥{threshold} $QQ on Base to unlock a personalized read across
        all five dimensions — what each one looks like in your actual choices
        and where the blind spots are.
      </p>
      {gated && (
        <p className="values-gated-balance">your balance: {balance} $QQ</p>
      )}
      {gated?.rpcError && (
        <p className="values-gated-balance">
          balance lookup failed — refresh the page to retry.
        </p>
      )}
      {gated?.inspected && gated.inspected.length > 0 && (
        <details className="values-gated-debug">
          <summary>checked {gated.inspected.length} wallet
            {gated.inspected.length === 1 ? '' : 's'}</summary>
          <ul>
            {gated.inspected.map((row) => (
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
        className="values-btn values-btn--secondary"
        onClick={() => setModalOpen(true)}
      >
        get $QQ
      </button>
      <GetQQModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        onSwapSuccess={handleSuccess}
        contextLine={`hold ≥${threshold} $QQ to unlock the breakdown`}
      />
    </section>
  );
};

// Context-card export hidden for now — at one quiz the markdown artifact is
// too thin to feel useful. Re-enable once the bartlet + values + hot-takes
// triad is complete; see project_triad_nft memory.
const UnlockedPanel: React.FC<{
  dimContent: DimContent;
  ranked: ValuesAxis[];
  fallback: { error: string | null } | null;
}> = ({ dimContent, ranked, fallback }) => {
  return (
    <section className="values-unlocked">
      <h3 className="values-unlocked-header">per-dimension breakdown</h3>
      {fallback && (
        <p className="values-unlocked-fallback">
          showing default reads — personalization failed
          {fallback.error && <> ({fallback.error})</>}
        </p>
      )}
      <ul className="values-dim-list">
        {ranked.map((d) => (
          <li key={d} className="values-dim-card">
            <h4>{DIM_LABEL[d]}</h4>
            <p className="values-dim-summary">{dimContent[d].summary}</p>
            <p className="values-dim-blindspot">
              <strong>blind spot:</strong> {dimContent[d].blindSpot}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
};

const AirdropBadge: React.FC<{ airdrop: AirdropInfo }> = ({ airdrop }) => {
  const explorer = (h: string) => `https://basescan.org/tx/${h}`;
  const amount = airdrop.amountTokens
    ? `${(Number(airdrop.amountTokens) / 1_000_000).toFixed(2)}M`
    : '4.42M';
  switch (airdrop.status) {
    case 'success':
    case 'already_claimed':
      return (
        <div className="values-airdrop values-airdrop--ok">
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
        <div className="values-airdrop">
          airdrop pool exhausted — first 1000 completions claimed it.
        </div>
      );
    case 'not_eligible':
      return (
        <div className="values-airdrop">
          airdrop skipped — neynar score below 0.9 threshold.
        </div>
      );
    case 'error':
    case 'disabled':
    case 'pending':
      return (
        <div className="values-airdrop">
          airdrop pending — refresh the page to retry.
        </div>
      );
  }
};

export default ValuesResult;
