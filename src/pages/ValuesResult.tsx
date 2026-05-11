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
import { useSearchParams } from 'react-router-dom';
import { sdk } from '@farcaster/miniapp-sdk';
import { Loader2, AlertCircle, Lock } from 'lucide-react';
import { GetQQModal } from '../components/GetQQModal';
import Header from '../components/Header';
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

// Spoke order, clockwise from 12 o'clock. Positions chosen so the two
// "self-direction" dims (Autonomy + Mastery) sit on opposite sides of the
// center axis — the radar reads as left-half/right-half intuitively.
const SPOKE_ORDER: ValuesAxis[] = [
  'autonomy',     //   0°  (top)
  'openness',     //  72°  (top-right)
  'mastery',      // 144°  (bottom-right)
  'universalism', // 216°  (bottom-left)
  'care',         // 288°  (top-left)
];

const ValuesResult: React.FC = () => {
  const [searchParams] = useSearchParams();
  const sid = searchParams.get('sid');

  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [result, setResult] = useState<FreeResult | null>(null);
  const [gated, setGated] = useState<GateState | null>(null);
  const [dimContent, setDimContent] = useState<DimContent | null>(null);

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
        dimContent: DimContent | null;
      };
      setSession(body.session);
      setGated(body.gated);
      setDimContent(body.dimContent);
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
        <h1>values</h1>
        <div className="values-badge">{result.badge.toUpperCase()}</div>
        <p className="values-secondary">secondary: {DIM_LABEL[result.secondary].toLowerCase()}</p>
      </header>

      <ValuesRadar scores={result.scores} />

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
      </section>

      {gated?.unlocked && dimContent ? (
        <UnlockedPanel
          dimContent={dimContent}
          ranked={SPOKE_ORDER.slice().sort(
            (a, b) => result.scores[b] - result.scores[a],
          )}
        />
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
}> = ({ dimContent, ranked }) => {
  return (
    <section className="values-unlocked">
      <h3 className="values-unlocked-header">per-dimension breakdown</h3>
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

// ─── Radar ───────────────────────────────────────────────────────────────

interface RadarProps {
  scores: ValuesScore;
}

const ValuesRadar: React.FC<RadarProps> = ({ scores }) => {
  const size = 320;
  const cx = size / 2;
  const cy = size / 2;
  const maxR = size * 0.4; // leave room for labels at the spokes
  const labelR = size * 0.46;

  // Convert (angleDeg from 12 o'clock, scaled radius) to (x, y).
  const point = (angleDeg: number, scale: number): [number, number] => {
    const rad = (angleDeg * Math.PI) / 180;
    return [cx + maxR * scale * Math.sin(rad), cy - maxR * scale * Math.cos(rad)];
  };
  const labelPos = (angleDeg: number): [number, number] => {
    const rad = (angleDeg * Math.PI) / 180;
    return [cx + labelR * Math.sin(rad), cy - labelR * Math.cos(rad)];
  };

  const angleFor = (dim: ValuesAxis) => {
    const idx = SPOKE_ORDER.indexOf(dim);
    return (idx * 360) / SPOKE_ORDER.length;
  };

  // Reference rings at 0.25, 0.5, 0.75, 1.0
  const rings = [0.25, 0.5, 0.75, 1.0].map((r) =>
    SPOKE_ORDER.map((d) => point(angleFor(d), r)),
  );

  // Score polygon
  const scorePoly = SPOKE_ORDER.map((d) => point(angleFor(d), scores[d]));

  const polyToString = (pts: [number, number][]) =>
    pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');

  return (
    <svg
      className="values-radar"
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label="values radar"
    >
      {rings.map((pts, i) => (
        <polygon
          key={i}
          points={polyToString(pts)}
          className={`values-radar-ring values-radar-ring--${i}`}
        />
      ))}
      {SPOKE_ORDER.map((d) => {
        const [x, y] = point(angleFor(d), 1);
        return (
          <line
            key={d}
            x1={cx}
            y1={cy}
            x2={x}
            y2={y}
            className="values-radar-spoke"
          />
        );
      })}
      <polygon points={polyToString(scorePoly)} className="values-radar-score" />
      {SPOKE_ORDER.map((d) => {
        const [x, y] = labelPos(angleFor(d));
        return (
          <text
            key={d}
            x={x}
            y={y}
            className="values-radar-label"
            textAnchor="middle"
            dominantBaseline="middle"
          >
            {DIM_LABEL[d]}
          </text>
        );
      })}
    </svg>
  );
};

export default ValuesResult;
