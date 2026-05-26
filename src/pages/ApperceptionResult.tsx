/**
 * /apperception/result — mini-app result page.
 *
 * Loads session via /api/apperception/session?sid=X (Quick Auth) and shows:
 *   - 3-spoke radar chart (equilateral triangle)
 *   - Style badge with confidence band
 *   - Summary paragraph
 *   - Signature answers
 *   - Share button
 *   - Rating prompt
 */

import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { sdk } from '@farcaster/miniapp-sdk';
import { Loader2, AlertCircle, ThumbsUp, ThumbsDown } from 'lucide-react';
import Header from '../components/Header';
import ApperceptionCube from '../components/ApperceptionCube';
import ApperceptionMeters from '../components/ApperceptionMeters';
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

type Phase = 'loading' | 'incomplete' | 'result' | 'error';

const dimLabels: Record<ApperceptionAxis, string> = {
  concrete: 'concrete',
  reflective: 'reflective',
  sequential: 'sequential',
};

// Mirrors worker/services/apperception/scoring.ts buildBreakdown labels.
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

export default function ApperceptionResult() {
  const [searchParams] = useSearchParams();
  const sid = searchParams.get('sid');

  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState<string | null>(null);
  const [free, setFree] = useState<FreeResult | null>(null);
  const [gated, setGated] = useState<GatedResult | null>(null);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [rated, setRated] = useState(false);

  useEffect(() => {
    if (!sid) {
      setError('Missing session ID');
      setPhase('error');
      return;
    }

    let cancelled = false;

    async function load() {
      try {
        const { token } = await sdk.quickAuth.getToken();
        const res = await fetch(`/api/apperception/session?sid=${encodeURIComponent(sid)}`, {
          headers: { Authorization: `Bearer ${token}` },
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
          <span className="style-badge">{style.style}</span>
          <span className="confidence-text" style={{ color: confidenceColor[style.confidence] }}>
            {style.confidence} fit
          </span>
        </div>

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

        {/* Gated: all styles breakdown */}
        {gated && gated.allStyles.length > 0 && (
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
                const high = free.scores[d] > 0.5;
                const pole = high ? poleLabels[d].high : poleLabels[d].low;
                const pct = Math.round(Math.abs(free.scores[d] - 0.5) * 2 * 100);
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
          </div>
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
