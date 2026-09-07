import React, { useEffect, useState, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { sdk } from '@farcaster/miniapp-sdk';
import { useWriteContract, useReadContract, useAccount } from 'wagmi';
import { erc20Abi, keccak256, toBytes, parseUnits } from 'viem';
import { base } from 'wagmi/chains';
import { Loader2, Lock, Unlock, AlertCircle, ChevronDown, ChevronUp } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { ResultAudienceBlock, type CompletionRef } from '../components/quiz/QuizAudienceChooser';
import './BartletUnlock.css';

const BACKEND = '';
const QQ_CONTRACT = '0x7d39833d9d5baa835ba19e964e4ba114521ccfe4' as const;
const QBASE_GATE_ADDRESS = '0x3fA4CC86B79d22Db14d0f3F9031F1a6F198b8DEC' as `0x${string}`; // Set after deploy
const BARTLET_CONTENT_ID = keccak256(toBytes('bartlet'));
const UNLOCK_PRICE = parseUnits('2210000', 18); // 2.21M $QQ

const gateAbi = [
  {
    name: 'unlock',
    type: 'function' as const,
    inputs: [{ name: 'contentId', type: 'bytes32' as const }],
    outputs: [],
    stateMutability: 'nonpayable' as const,
  },
] as const;

interface SessionData {
  id: string;
  fid: number;
  answers: unknown[];
  paid: boolean;
  airdropped: boolean;
  airdropTxHash?: string;
  /** the completion the audience chooser is for (from the session endpoint) */
  completion?: CompletionRef | null;
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

type Phase = 'loading' | 'offer' | 'approving' | 'unlocking' | 'verifying' | 'result' | 'error';

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
      const { session: s, completion } = (await res.json()) as { session: SessionData; completion?: CompletionRef | null };
      setSession({ ...s, completion: completion ?? null });

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

  const { writeContractAsync } = useWriteContract();
  const { address: userAddress } = useAccount();

  // Check existing allowance so we can skip approve on retry
  const { data: allowance } = useReadContract({
    address: QQ_CONTRACT,
    abi: erc20Abi,
    functionName: 'allowance',
    args: userAddress && QBASE_GATE_ADDRESS ? [userAddress, QBASE_GATE_ADDRESS] : undefined,
  });

  const handleUnlock = async () => {
    if (!sid || !session) return;

    try {
      // Step 1: Approve (skip if already sufficient)
      const needsApproval = !allowance || allowance < UNLOCK_PRICE;
      if (needsApproval) {
        setPhase('approving');
        await writeContractAsync({
          address: QQ_CONTRACT,
          abi: erc20Abi,
          functionName: 'approve',
          args: [QBASE_GATE_ADDRESS, UNLOCK_PRICE],
          chain: base,
          account: userAddress!,
        });
      }

      // Step 2: Unlock via QbaseGate
      setPhase('unlocking');
      const txHash = await writeContractAsync({
        address: QBASE_GATE_ADDRESS,
        abi: gateAbi,
        functionName: 'unlock',
        args: [BARTLET_CONTENT_ID],
        chain: base,
        account: userAddress!,
      });

      // Step 3: Verify on server
      setPhase('verifying');
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
      const msg = e instanceof Error ? e.message : 'Unlock failed';
      // User rejected in wallet — go back to offer
      if (msg.includes('rejected') || msg.includes('denied')) {
        setPhase('offer');
        return;
      }
      setError(msg);
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
        {phase === 'approving' && <ProgressState label="Approving $QQ..." />}
        {phase === 'unlocking' && <ProgressState label="Unlocking..." />}
        {phase === 'verifying' && <ProgressState label="Verifying transaction..." />}
        {phase === 'result' && paidResult && <ResultView result={paidResult} />}
        {(phase === 'offer' || phase === 'result') && session ? (
          <ResultAudienceBlock completion={session.completion} />
        ) : null}
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
    </div>
  );
}

export default BartletUnlock;
