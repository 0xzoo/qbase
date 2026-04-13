import React, { useEffect, useState, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { sdk } from '@farcaster/miniapp-sdk';
import { Loader2, Lock, Unlock, AlertCircle, ChevronDown, ChevronUp, Eye, EyeOff } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import './BartletUnlock.css';

const BACKEND = '';
const QQ_CONTRACT = '0x7d39833d9d5baa835ba19e964e4ba114521ccfe4';
// CAIP-19 for $QQ on Base (chain 8453)
const QQ_CAIP19 = `eip155:8453/erc20:${QQ_CONTRACT}`;
// 2.21M $QQ — sendToken takes amount as raw units string (18 decimals)
const UNLOCK_AMOUNT = '2210000000000000000000000';
// Treasury address — injected at build time or hardcoded for now
const TREASURY_ADDRESS = '0x278603E93fE7B1517FD69eFA65BABda33beFbEe1';

interface SessionData {
  id: string;
  fid: number;
  answers: unknown[];
  paid: boolean;
  airdropped: boolean;
  airdropTxHash?: string;
}

interface QuadrantDistribution {
  Achiever: number;
  Explorer: number;
  Killer: number;
  Socializer: number;
}

interface PaidResult {
  dominant: string;
  runnerUp: string;
  summary: string;
  signatureAnswers: string[];
  blindSpot: string;
  hybrid: string | null;
  displayLabel: string;
  orientation: number;
  engagement: number;
  confidence: number;
  hybridLabel: string;
  hybridEvidence: string;
  axisNarratives: { orientation: string; engagement: string };
  quadrantDistribution: QuadrantDistribution;
  recommendations: string[];
}

type Phase = 'loading' | 'offer' | 'sending' | 'verifying' | 'result' | 'error';

const QUADRANT_SYMBOLS: Record<string, string> = {
  Achiever: '\u2666',
  Explorer: '\u2660',
  Killer: '\u2663',
  Socializer: '\u2665',
};

const BartletUnlock: React.FC = () => {
  const [searchParams] = useSearchParams();
  const sid = searchParams.get('sid');
  const { isMiniApp } = useAuth();

  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<SessionData | null>(null);
  const [paidResult, setPaidResult] = useState<PaidResult | null>(null);

  // Load session on mount
  useEffect(() => {
    if (!sid) {
      setError('Missing session ID');
      setPhase('error');
      return;
    }
    loadSession();
  }, [sid]);

  const loadSession = useCallback(async () => {
    if (!sid) return;
    try {
      setPhase('loading');
      const res = await sdk.quickAuth.fetch(
        `${BACKEND}/api/bartlet/session?sid=${encodeURIComponent(sid)}`
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
      }
      const { session: s } = (await res.json()) as { session: SessionData };
      setSession(s);

      if (s.paid) {
        // Already paid — fetch the paid result
        await fetchUnlockResult(sid);
      } else {
        setPhase('offer');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load session');
      setPhase('error');
    }
  }, [sid]);

  const fetchUnlockResult = async (sessionId: string) => {
    const res = await sdk.quickAuth.fetch(`${BACKEND}/api/bartlet/unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sid: sessionId, txHash: '0x0' }),
    });
    if (!res.ok) throw new Error('Failed to load paid result');
    const { paid } = (await res.json()) as { paid: PaidResult };
    setPaidResult(paid);
    setPhase('result');
  };

  const handleUnlock = async () => {
    if (!sid || !session) return;

    try {
      setPhase('sending');

      const result = await sdk.actions.sendToken({
        token: QQ_CAIP19,
        amount: UNLOCK_AMOUNT,
        recipientAddress: TREASURY_ADDRESS,
      });

      if (result.success === false) {
        if (result.reason === 'rejected_by_user') {
          setPhase('offer');
          return;
        }
        throw new Error(result.error?.message || 'Token send failed');
      }

      // Got txHash — verify on server
      setPhase('verifying');
      const txHash = result.send.transaction;

      const res = await sdk.quickAuth.fetch(`${BACKEND}/api/bartlet/unlock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sid, txHash }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error || 'Unlock verification failed');
      }

      const { paid } = (await res.json()) as { paid: PaidResult };
      setPaidResult(paid);
      setPhase('result');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unlock failed');
      setPhase('error');
    }
  };

  if (!isMiniApp) {
    return (
      <div className="bartlet-unlock">
        <div className="bartlet-container">
          <div className="bartlet-gate">
            <Lock className="bartlet-gate-icon" size={48} />
            <h1 className="bartlet-gate-title">Open in Warpcast</h1>
            <p className="bartlet-gate-text">
              The Bartlet unlock is available as a Farcaster mini-app. Open this link in Warpcast to continue.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="bartlet-unlock">
      <div className="bartlet-container">
        <h1 className="bartlet-title">Bartlet Deep Dive</h1>

        {phase === 'loading' && <LoadingState />}
        {phase === 'offer' && <OfferCard onUnlock={handleUnlock} />}
        {phase === 'sending' && <ProgressState label="Sending $QQ..." />}
        {phase === 'verifying' && <ProgressState label="Verifying transaction..." />}
        {phase === 'result' && paidResult && <ResultView result={paidResult} />}
        {phase === 'error' && (
          <ErrorState
            message={error || 'Something went wrong'}
            onRetry={() => {
              setError(null);
              loadSession();
            }}
          />
        )}
      </div>
    </div>
  );
};

function LoadingState() {
  return (
    <div className="bartlet-status">
      <Loader2 className="bartlet-spinner" size={32} />
      <p className="bartlet-status-text">Loading your session...</p>
    </div>
  );
}

function ProgressState({ label }: { label: string }) {
  return (
    <div className="bartlet-status">
      <Loader2 className="bartlet-spinner" size={32} />
      <p className="bartlet-status-text">{label}</p>
    </div>
  );
}

function OfferCard({ onUnlock }: { onUnlock: () => void }) {
  return (
    <div className="bartlet-card">
      <div className="bartlet-offer-header">
        <Lock className="bartlet-offer-icon" size={36} />
        <h2 className="bartlet-offer-title">Unlock your full profile</h2>
        <p className="bartlet-offer-desc">
          Your free result showed your dominant archetype. The deep dive unlocks
          your exact coordinates, hybrid analysis, axis narratives, and personalized
          recommendations.
        </p>
      </div>

      <div className="bartlet-offer-features">
        <div className="bartlet-feature-row">
          <span>Orientation & Engagement scores</span>
          <Unlock size={14} className="bartlet-feature-icon" />
        </div>
        <div className="bartlet-feature-row">
          <span>Hybrid archetype analysis</span>
          <Unlock size={14} className="bartlet-feature-icon" />
        </div>
        <div className="bartlet-feature-row">
          <span>Quadrant distribution breakdown</span>
          <Unlock size={14} className="bartlet-feature-icon" />
        </div>
        <div className="bartlet-feature-row">
          <span>Personalized recommendations</span>
          <Unlock size={14} className="bartlet-feature-icon" />
        </div>
      </div>

      <button onClick={onUnlock} className="bartlet-unlock-btn">
        Unlock for 2.21M $QQ
      </button>

      <p className="bartlet-payment-note">
        Payment is processed on Base via your Farcaster wallet.
      </p>
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="bartlet-card bartlet-error-card">
      <AlertCircle className="bartlet-error-icon" size={36} />
      <p className="bartlet-error-text">{message}</p>
      <button onClick={onRetry} className="bartlet-retry-btn">
        Try again
      </button>
    </div>
  );
}

interface QuizCompletion {
  id: string;
  visibility: 'private' | 'public' | 'anon';
}

function PrivacyToggle() {
  const [completion, setCompletion] = useState<QuizCompletion | null>(null);
  const [loading, setLoading] = useState(true);
  const [revealing, setRevealing] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await sdk.quickAuth.fetch(
          `${BACKEND}/api/quiz-completions?user_id=me`
        );
        if (!res.ok) { setLoading(false); return; }
        const { completions } = (await res.json()) as { completions: QuizCompletion[] };
        const bartlet = completions.find(
          (c: QuizCompletion & { quiz_id?: string }) =>
            (c as QuizCompletion & { quiz_id: string }).quiz_id === 'bartlet'
        );
        if (bartlet) setCompletion(bartlet);
      } catch {
        // non-fatal
      }
      setLoading(false);
    })();
  }, []);

  const handleReveal = async () => {
    if (!completion) return;
    setRevealing(true);
    try {
      const res = await sdk.quickAuth.fetch(
        `${BACKEND}/api/quiz-completions/${completion.id}/reveal`,
        { method: 'POST' }
      );
      if (res.ok) {
        setCompletion({ ...completion, visibility: 'public' });
        setConfirming(false);
      }
    } catch {
      // non-fatal
    }
    setRevealing(false);
  };

  if (loading || !completion) return null;

  const isPublic = completion.visibility === 'public';

  return (
    <div className="bartlet-card">
      <h3 className="bartlet-section-label">Answer Privacy</h3>
      <div className="bartlet-privacy-row">
        <div className="bartlet-privacy-status">
          {isPublic ? (
            <Eye size={16} className="bartlet-privacy-icon-public" />
          ) : (
            <EyeOff size={16} className="bartlet-privacy-icon-private" />
          )}
          <span>
            {isPublic ? 'Your answers are public' : 'Your answers are private'}
          </span>
        </div>
        {!isPublic && !confirming && (
          <button
            onClick={() => setConfirming(true)}
            className="bartlet-privacy-toggle-btn"
          >
            Make public
          </button>
        )}
      </div>
      {!isPublic && confirming && (
        <div className="bartlet-confirm-box">
          <p className="bartlet-confirm-text">
            This will make your individual quiz answers visible to anyone who views your
            qbase profile. Your result type is already visible -- this reveals the specific
            choices you made.
          </p>
          <div className="bartlet-confirm-actions">
            <button
              onClick={handleReveal}
              disabled={revealing}
              className="bartlet-confirm-btn"
            >
              {revealing ? 'Revealing...' : 'Confirm'}
            </button>
            <button
              onClick={() => setConfirming(false)}
              className="bartlet-cancel-btn"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {isPublic && (
        <p className="bartlet-privacy-note">
          Your quiz answers are now part of your public qbase profile.
        </p>
      )}
    </div>
  );
}

function ResultView({ result }: { result: PaidResult }) {
  const [showDist, setShowDist] = useState(false);

  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const coord = (v: number) => (v >= 0 ? `+${v.toFixed(2)}` : v.toFixed(2));

  const imageSlug = result.displayLabel.toLowerCase();

  return (
    <div className="bartlet-results">
      {/* Archetype image */}
      <img
        src={`/r2/bartlet/${imageSlug}.png`}
        alt={result.displayLabel}
        className="bartlet-archetype-img"
      />

      {/* Header */}
      <div className="bartlet-card bartlet-type-header">
        <p className="bartlet-section-label">Your Bartlet Type</p>
        <h2 className="bartlet-type-name">{result.displayLabel}</h2>
        <p className="bartlet-type-hybrid">{result.hybridLabel}</p>
      </div>

      {/* Coordinates */}
      <div className="bartlet-card">
        <h3 className="bartlet-section-label">Coordinates</h3>
        <div className="bartlet-coord-grid">
          <div className="bartlet-coord-cell">
            <p className="bartlet-coord-label">Orientation</p>
            <p className="bartlet-coord-value">{coord(result.orientation)}</p>
            <p className="bartlet-coord-axis">Players \u2190 \u2192 World</p>
          </div>
          <div className="bartlet-coord-cell">
            <p className="bartlet-coord-label">Engagement</p>
            <p className="bartlet-coord-value">{coord(result.engagement)}</p>
            <p className="bartlet-coord-axis">Interacting \u2190 \u2192 Acting</p>
          </div>
        </div>
        <div className="bartlet-coord-cell bartlet-confidence-cell">
          <p className="bartlet-coord-label">Confidence</p>
          <p className="bartlet-coord-value bartlet-confidence-value">{pct(result.confidence)}</p>
        </div>
      </div>

      {/* Axis Narratives */}
      <div className="bartlet-card">
        <h3 className="bartlet-section-label">Axis Narratives</h3>
        <div className="bartlet-narratives">
          <p>{result.axisNarratives.orientation}</p>
          <p>{result.axisNarratives.engagement}</p>
        </div>
      </div>

      {/* Hybrid Evidence */}
      {result.hybrid && (
        <div className="bartlet-card">
          <h3 className="bartlet-section-label">Hybrid Analysis</h3>
          <p className="bartlet-body-text">{result.hybridEvidence}</p>
        </div>
      )}

      {/* Quadrant Distribution */}
      <div className="bartlet-card">
        <button
          onClick={() => setShowDist(!showDist)}
          className="bartlet-collapsible-header"
        >
          <span>Quadrant Distribution</span>
          {showDist ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </button>
        {showDist && (
          <div className="bartlet-distribution">
            {(Object.entries(result.quadrantDistribution) as [string, number][]).map(
              ([name, value]) => (
                <div key={name} className="bartlet-dist-row">
                  <div className="bartlet-dist-labels">
                    <span className="bartlet-dist-name">
                      {QUADRANT_SYMBOLS[name]} {name}
                    </span>
                    <span className="bartlet-dist-value">{pct(value)}</span>
                  </div>
                  <div className="bartlet-dist-track">
                    <div
                      className="bartlet-dist-fill"
                      style={{ width: pct(value) }}
                    />
                  </div>
                </div>
              )
            )}
          </div>
        )}
      </div>

      {/* Summary + Blind Spot */}
      <div className="bartlet-card">
        <h3 className="bartlet-section-label">Summary</h3>
        <p className="bartlet-body-text">{result.summary}</p>
        <h3 className="bartlet-section-label bartlet-section-label-spaced">Blind Spot</h3>
        <p className="bartlet-body-text bartlet-body-dim">{result.blindSpot}</p>
      </div>

      {/* Recommendations */}
      <div className="bartlet-card">
        <h3 className="bartlet-section-label">Recommendations</h3>
        <ol className="bartlet-recs">
          {result.recommendations.map((rec, i) => (
            <li key={i}>
              <span className="bartlet-rec-num">{i + 1}.</span>
              <span>{rec}</span>
            </li>
          ))}
        </ol>
      </div>

      {/* Privacy Toggle */}
      <PrivacyToggle />
    </div>
  );
}

export default BartletUnlock;
