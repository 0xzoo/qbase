/**
 * QuizzesFeed — landing for the three Farcaster-snap quizzes
 *   apperception · values · bartlet
 *
 * Each card is a takeable link to /quiz/{slug} (the browser quiz UI). For
 * signed-in users we tag each card with completion state from
 * `/api/me/quizzes` (apperception lives in KV, values+bartlet live in
 * `quiz_completions`; the endpoint hides that asymmetry behind one shape).
 *
 * Card visual identity matches each quiz's snap accent + geometry:
 *   apperception → purple triangle  (3 cognitive axes)
 *   values       → blue pentagon    (5 moral axes)
 *   bartlet      → amber star       (Farcaster archetypes)
 */

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Check } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { apiClient } from '../lib/apiClient';
import './QuizzesFeed.css';

interface QuizMeta {
  slug: string;
  title: string;
  tagline: string;
  questionCount: number;
  estMinutes: number;
  /** Tailwindless CSS accent — sets a card-local --accent variable. */
  accent: string;
  /** SVG glyph rendered in the card's geometric badge. */
  glyph: 'triangle' | 'pentagon' | 'star';
  /** Single-word dimension chips shown below the tagline. */
  dimensions: string[];
}

const QUIZZES: QuizMeta[] = [
  {
    slug: 'apperception',
    title: 'app·erception',
    tagline: 'find your cognitive style — some self-assembly required',
    questionCount: 21,
    estMinutes: 5,
    accent: '#8b5cf6',
    glyph: 'triangle',
    dimensions: ['concrete', 'reflective', 'sequential'],
  },
  {
    slug: 'values',
    title: 'values',
    tagline: 'find your moral shape',
    questionCount: 21,
    estMinutes: 5,
    accent: '#0ea5e9',
    glyph: 'pentagon',
    dimensions: ['autonomy', 'care', 'openness', 'mastery', 'universalism'],
  },
  {
    slug: 'bartlet',
    title: 'bartlet',
    tagline: 'find your Farcaster archetype',
    questionCount: 10,
    estMinutes: 3,
    accent: '#f59e0b',
    glyph: 'star',
    dimensions: ['10 archetypes'],
  },
];

interface QuizStatus {
  completed: boolean;
  completedAt: number | null;
  resultCategory: string | null;
}

type StatusMap = Record<string, QuizStatus>;

export default function QuizzesFeed() {
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const [statuses, setStatuses] = useState<StatusMap | null>(null);
  const [statusesLoading, setStatusesLoading] = useState(false);

  useEffect(() => {
    if (authLoading || !isAuthenticated) {
      setStatuses(null);
      return;
    }
    let cancelled = false;
    setStatusesLoading(true);
    (async () => {
      try {
        const res = await apiClient.get('/api/me/quizzes');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as StatusMap;
        if (!cancelled) setStatuses(data);
      } catch (e) {
        // Non-fatal — page still works, cards just won't show "taken" state.
        console.warn('[QuizzesFeed] /api/me/quizzes failed:', e);
        if (!cancelled) setStatuses(null);
      } finally {
        if (!cancelled) setStatusesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authLoading, isAuthenticated]);

  const completedCount = useMemo(() => {
    if (!statuses) return 0;
    return Object.values(statuses).filter((s) => s.completed).length;
  }, [statuses]);

  return (
    <div className="qz-feed">
      <header className="qz-hero">
        <p className="qz-eyebrow">three short quizzes</p>
        <h1 className="qz-hero-title">know yourself, briefly.</h1>
        <p className="qz-hero-sub">
          each takes a few minutes. results stay on your card —
          {' '}
          {isAuthenticated ? (
            <span>
              you've finished <strong>{completedCount}</strong> of {QUIZZES.length}.
            </span>
          ) : (
            <span>sign in to track which ones you've taken.</span>
          )}
        </p>
      </header>

      {isAuthenticated && completedCount > 0 ? (
        <nav className="qz-me-links" aria-label="your quiz answers">
          <Link to="/me/answers">your answers &amp; visibility</Link>
          <span aria-hidden="true">·</span>
          <Link to="/me/report">what they say about you</Link>
          {statuses?.values?.completed ? (
            <>
              <span aria-hidden="true">·</span>
              <Link to="/values/compare">compare values with a friend</Link>
            </>
          ) : null}
        </nav>
      ) : null}

      <div className="qz-grid">
        {QUIZZES.map((q) => (
          <QuizCard
            key={q.slug}
            quiz={q}
            status={statuses?.[q.slug] ?? null}
            statusLoading={statusesLoading}
          />
        ))}
      </div>

      <footer className="qz-foot">
        <span>by @qbase</span>
        <span aria-hidden="true">·</span>
        <Link to="/about" className="qz-foot-link">what is qbase?</Link>
      </footer>
    </div>
  );
}

interface CardProps {
  quiz: QuizMeta;
  status: QuizStatus | null;
  statusLoading: boolean;
}

function QuizCard({ quiz, status, statusLoading }: CardProps) {
  const completed = status?.completed === true;

  // Pretty result category — many are ALLCAPS in the backend; keep
  // capitalization as-stored so each quiz's house style still reads.
  const resultLabel = status?.resultCategory ?? null;
  const takenAt = status?.completedAt
    ? formatRelative(status.completedAt)
    : null;

  return (
    <Link
      to={`/quiz/${quiz.slug}`}
      className={`qz-card ${completed ? 'qz-card-done' : ''}`}
      style={{ ['--accent' as string]: quiz.accent }}
    >
      <div className="qz-card-top">
        <div className="qz-badge" aria-hidden="true">
          <Glyph kind={quiz.glyph} />
        </div>
        <div className="qz-card-meta">
          <span className="qz-meta-row">
            <span>{quiz.questionCount} questions</span>
            <span aria-hidden="true">·</span>
            <span>~{quiz.estMinutes} min</span>
          </span>
          {statusLoading ? (
            <span className="qz-status qz-status-loading" aria-hidden="true">
              …
            </span>
          ) : completed ? (
            <span className="qz-status qz-status-done">
              <Check size={12} strokeWidth={3} />
              taken
              {takenAt ? <span className="qz-status-when"> {takenAt}</span> : null}
            </span>
          ) : (
            <span className="qz-status qz-status-todo">→ take it</span>
          )}
        </div>
      </div>

      <h2 className="qz-card-title">{quiz.title}</h2>
      <p className="qz-card-tagline">{quiz.tagline}</p>

      <ul className="qz-dim-chips" aria-label="dimensions">
        {quiz.dimensions.map((d) => (
          <li key={d} className="qz-chip">{d}</li>
        ))}
      </ul>

      <div className="qz-card-cta">
        {completed ? (
          <>
            <span className="qz-cta-label">
              you're <strong>{resultLabel ?? 'sorted'}</strong>
            </span>
            <span className="qz-cta-arrow">retake <ArrowRight size={14} /></span>
          </>
        ) : (
          <>
            <span className="qz-cta-label">begin</span>
            <span className="qz-cta-arrow"><ArrowRight size={14} /></span>
          </>
        )}
      </div>
    </Link>
  );
}

// ─── glyphs ──────────────────────────────────────────────────────────────
// Inline SVG — keeps the badges crisp at any density, no extra asset round-trip.
// Stroke uses currentColor so the parent's --accent paints it.

function Glyph({ kind }: { kind: 'triangle' | 'pentagon' | 'star' }) {
  if (kind === 'triangle') {
    // Equilateral, anchored top — mirrors the apperception 3-axis radar.
    return (
      <svg viewBox="0 0 40 40" width="100%" height="100%" aria-hidden="true">
        <polygon
          points="20,4 36,32 4,32"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinejoin="round"
        />
        <circle cx="20" cy="20" r="2" fill="currentColor" />
      </svg>
    );
  }
  if (kind === 'pentagon') {
    // Regular pentagon, point up — mirrors the values 5-axis chart.
    return (
      <svg viewBox="0 0 40 40" width="100%" height="100%" aria-hidden="true">
        <polygon
          points="20,4 37,17 30,36 10,36 3,17"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinejoin="round"
        />
        <circle cx="20" cy="22" r="2" fill="currentColor" />
      </svg>
    );
  }
  // star — 5-pointed, for the Farcaster cast of characters
  return (
    <svg viewBox="0 0 40 40" width="100%" height="100%" aria-hidden="true">
      <polygon
        points="20,3 24.7,15.3 38,16 27.5,24.5 31,37.5 20,30.2 9,37.5 12.5,24.5 2,16 15.3,15.3"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// ─── relative time ───────────────────────────────────────────────────────
// Lightweight — full Intl.RelativeTimeFormat plumbing would dwarf the
// callsite; a few buckets is enough for a "taken X ago" annotation.

function formatRelative(unixMs: number): string {
  const now = Date.now();
  const diff = Math.max(0, now - unixMs);
  const min = 60_000;
  const hr = 60 * min;
  const day = 24 * hr;
  if (diff < hr) return `${Math.max(1, Math.round(diff / min))}m ago`;
  if (diff < day) return `${Math.round(diff / hr)}h ago`;
  if (diff < 30 * day) return `${Math.round(diff / day)}d ago`;
  const months = Math.round(diff / (30 * day));
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}
