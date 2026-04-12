import React, { useEffect, useState, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { sdk } from '@farcaster/miniapp-sdk';
import { Loader2, Lock, Unlock, AlertCircle, ChevronDown, ChevronUp } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

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
    // For already-paid sessions, POST with a dummy txHash to get the result back
    // The server returns the paid result for already-paid sessions regardless of txHash
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
      <div className="min-h-screen bg-black text-white flex items-center justify-center p-4">
        <div className="text-center space-y-4 max-w-sm">
          <Lock className="mx-auto text-gray-500" size={48} />
          <h1 className="text-xl font-bold">Open in Warpcast</h1>
          <p className="text-gray-400 text-sm">
            The Bartlet unlock is available as a Farcaster mini-app. Open this link in Warpcast to continue.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-black text-white">
      <div className="max-w-lg mx-auto px-4 py-8 space-y-6">
        <h1 className="text-2xl font-bold text-center">Bartlet Deep Dive</h1>

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
    <div className="flex flex-col items-center justify-center py-16 space-y-4">
      <Loader2 className="animate-spin text-purple-400" size={32} />
      <p className="text-gray-400 text-sm">Loading your session...</p>
    </div>
  );
}

function ProgressState({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 space-y-4">
      <Loader2 className="animate-spin text-purple-400" size={32} />
      <p className="text-gray-400 text-sm">{label}</p>
    </div>
  );
}

function OfferCard({ onUnlock }: { onUnlock: () => void }) {
  return (
    <div className="bg-gray-900 rounded-2xl p-6 space-y-5">
      <div className="text-center space-y-2">
        <Lock className="mx-auto text-purple-400" size={36} />
        <h2 className="text-lg font-semibold">Unlock your full profile</h2>
        <p className="text-gray-400 text-sm leading-relaxed">
          Your free result showed your dominant archetype. The deep dive unlocks
          your exact coordinates, hybrid analysis, axis narratives, and personalized
          recommendations.
        </p>
      </div>

      <div className="bg-gray-800 rounded-xl p-4 space-y-2 text-sm">
        <div className="flex justify-between">
          <span className="text-gray-400">Orientation & Engagement scores</span>
          <Unlock size={14} className="text-purple-400" />
        </div>
        <div className="flex justify-between">
          <span className="text-gray-400">Hybrid archetype analysis</span>
          <Unlock size={14} className="text-purple-400" />
        </div>
        <div className="flex justify-between">
          <span className="text-gray-400">Quadrant distribution breakdown</span>
          <Unlock size={14} className="text-purple-400" />
        </div>
        <div className="flex justify-between">
          <span className="text-gray-400">Personalized recommendations</span>
          <Unlock size={14} className="text-purple-400" />
        </div>
      </div>

      <button
        onClick={onUnlock}
        className="w-full bg-purple-600 hover:bg-purple-500 text-white font-semibold py-3 px-4 rounded-xl transition-colors"
      >
        Unlock for 2.21M $QQ
      </button>

      <p className="text-center text-gray-500 text-xs">
        Payment is processed on Base via your Farcaster wallet.
      </p>
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="bg-gray-900 rounded-2xl p-6 text-center space-y-4">
      <AlertCircle className="mx-auto text-red-400" size={36} />
      <p className="text-red-300 text-sm">{message}</p>
      <button
        onClick={onRetry}
        className="bg-gray-800 hover:bg-gray-700 text-white text-sm py-2 px-6 rounded-lg transition-colors"
      >
        Try again
      </button>
    </div>
  );
}

function ResultView({ result }: { result: PaidResult }) {
  const [showDist, setShowDist] = useState(false);

  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const coord = (v: number) => (v >= 0 ? `+${v.toFixed(2)}` : v.toFixed(2));

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="bg-gray-900 rounded-2xl p-5 text-center space-y-2">
        <p className="text-purple-400 text-xs font-medium uppercase tracking-wider">
          Your Bartlet Type
        </p>
        <h2 className="text-2xl font-bold">{result.displayLabel}</h2>
        <p className="text-gray-400 text-sm">{result.hybridLabel}</p>
      </div>

      {/* Coordinates */}
      <div className="bg-gray-900 rounded-2xl p-5 space-y-3">
        <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">
          Coordinates
        </h3>
        <div className="grid grid-cols-2 gap-4">
          <div className="bg-gray-800 rounded-xl p-3 text-center">
            <p className="text-xs text-gray-500">Orientation</p>
            <p className="text-xl font-mono font-bold">{coord(result.orientation)}</p>
            <p className="text-xs text-gray-500 mt-1">Players ← → World</p>
          </div>
          <div className="bg-gray-800 rounded-xl p-3 text-center">
            <p className="text-xs text-gray-500">Engagement</p>
            <p className="text-xl font-mono font-bold">{coord(result.engagement)}</p>
            <p className="text-xs text-gray-500 mt-1">Interacting ← → Acting</p>
          </div>
        </div>
        <div className="bg-gray-800 rounded-xl p-3 text-center">
          <p className="text-xs text-gray-500">Confidence</p>
          <p className="text-lg font-mono font-bold">{pct(result.confidence)}</p>
        </div>
      </div>

      {/* Axis Narratives */}
      <div className="bg-gray-900 rounded-2xl p-5 space-y-3">
        <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">
          Axis Narratives
        </h3>
        <div className="space-y-2">
          <p className="text-sm text-gray-300">{result.axisNarratives.orientation}</p>
          <p className="text-sm text-gray-300">{result.axisNarratives.engagement}</p>
        </div>
      </div>

      {/* Hybrid Evidence */}
      {result.hybrid && (
        <div className="bg-gray-900 rounded-2xl p-5 space-y-3">
          <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">
            Hybrid Analysis
          </h3>
          <p className="text-sm text-gray-300">{result.hybridEvidence}</p>
        </div>
      )}

      {/* Quadrant Distribution */}
      <div className="bg-gray-900 rounded-2xl p-5 space-y-3">
        <button
          onClick={() => setShowDist(!showDist)}
          className="w-full flex items-center justify-between text-sm font-semibold text-gray-300 uppercase tracking-wider"
        >
          <span>Quadrant Distribution</span>
          {showDist ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </button>
        {showDist && (
          <div className="space-y-2 pt-2">
            {(Object.entries(result.quadrantDistribution) as [string, number][]).map(
              ([name, value]) => (
                <div key={name} className="space-y-1">
                  <div className="flex justify-between text-xs">
                    <span className="text-gray-400">{name}</span>
                    <span className="text-gray-300 font-mono">{pct(value)}</span>
                  </div>
                  <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-purple-500 rounded-full transition-all"
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
      <div className="bg-gray-900 rounded-2xl p-5 space-y-3">
        <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">
          Summary
        </h3>
        <p className="text-sm text-gray-300 leading-relaxed">{result.summary}</p>
        <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wider pt-2">
          Blind Spot
        </h3>
        <p className="text-sm text-gray-400 leading-relaxed">{result.blindSpot}</p>
      </div>

      {/* Recommendations */}
      <div className="bg-gray-900 rounded-2xl p-5 space-y-3">
        <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">
          Recommendations
        </h3>
        <ul className="space-y-3">
          {result.recommendations.map((rec, i) => (
            <li key={i} className="flex gap-3 text-sm text-gray-300">
              <span className="text-purple-400 font-bold flex-shrink-0">{i + 1}.</span>
              <span>{rec}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export default BartletUnlock;
