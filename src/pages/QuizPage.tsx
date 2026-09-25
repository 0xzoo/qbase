/**
 * /quiz/:slug — browser-based quiz taking UI.
 *
 * Backs the three quizzes that historically only existed as Farcaster snaps:
 *   /quiz/apperception  /quiz/values  /quiz/bartlet
 *
 * Sign-in is required (SIWF web or MiniApp Quick Auth). Session sid is
 * persisted in localStorage so a page reload mid-quiz resumes in place.
 *
 * On completion, navigates to each quiz's existing result page:
 *   apperception → /apperception/result?sid=…
 *   values       → /values/result?sid=…
 *   bartlet      → /bartlet/unlock?sid=…
 *
 * Snap clients still hit /snap/{slug} (unchanged); the SPA only handles the
 * /quiz/{slug} browser route. /snap/{slug} → /quiz/{slug} JS-redirects via
 * App.tsx Navigate, so a browser that lands on the snap URL ends up here.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Loader2, AlertCircle } from 'lucide-react';
import Header from '../components/Header';
import { useAuth } from '../context/AuthContext';
import './QuizPage.css';

type WebQuestion =
  | { id: string; stem: string; type: 'likert' }
  | { id: string; stem: string; type: 'forced'; a_options: { label: string }[] }
  | { id: string; stem: string; type: 'open' }
  | { id: string; stem: string; type: 'mc'; a_options: { label: string }[] };

interface SessionSummary {
  sid: string;
  fid: number;
  index: number;
  total: number;
  completed: boolean;
  createdAt: number;
}

interface QuizConfig {
  slug: string;
  title: string;
  tagline: string;
  apiBase: string;            // e.g. /api/apperception/web
  resultPath: (sid: string) => string;
}

const QUIZZES: Record<string, QuizConfig> = {
  apperception: {
    slug: 'apperception',
    title: 'app·erception',
    tagline: 'find your cognitive style — some self-assembly required',
    apiBase: '/api/apperception/web',
    resultPath: (sid) => `/apperception/result?sid=${encodeURIComponent(sid)}`,
  },
  values: {
    slug: 'values',
    title: 'values',
    tagline: 'find your moral shape — autonomy, care, openness, mastery, universalism',
    apiBase: '/api/values/web',
    resultPath: (sid) => `/values/result?sid=${encodeURIComponent(sid)}`,
  },
  bartlet: {
    slug: 'bartlet',
    title: 'bartlet',
    tagline: 'find your Farcaster archetype',
    apiBase: '/api/bartlet/web',
    resultPath: (sid) => `/bartlet/unlock?sid=${encodeURIComponent(sid)}`,
  },
  'ca-slate': {
    slug: 'ca-slate',
    title: 'ca slate',
    tagline: 'your picks across 8 california statewide offices',
    apiBase: '/api/ca-slate/web',
    resultPath: (sid) => `/ca-slate/result?sid=${encodeURIComponent(sid)}`,
  },
};

// 5-button likert order shown top→bottom. Stored position is the original
// SD→SA index (0..4); display order surfaces "strongly agree" first to
// mirror the snap UI without affecting scoring.
const LIKERT_LABELS: ReadonlyArray<{ label: string; position: number }> = [
  { label: 'strongly agree', position: 4 },
  { label: 'agree', position: 3 },
  { label: 'neutral', position: 2 },
  { label: 'disagree', position: 1 },
  { label: 'strongly disagree', position: 0 },
];

type Phase = 'loading' | 'unauth' | 'intro' | 'asking' | 'submitting' | 'error';

/** A relative, same-origin path (`/values/compare?a=…`) or null. */
function safeNextPath(raw: string | null): string | null {
  if (!raw) return null;
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return null;
  return raw;
}

function lsKey(slug: string, fid: number | undefined): string | null {
  if (!fid) return null;
  return `qbase:quiz:${slug}:sid:${fid}`;
}

export default function QuizPage() {
  const { slug = '' } = useParams<{ slug: string }>();
  const config = QUIZZES[slug];
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // `?next=/path` sends the finisher somewhere other than the result page
  // (the values compare page uses it: "take the quiz, then come back").
  // Same-origin paths only.
  const nextPath = safeNextPath(searchParams.get('next'));
  const { isAuthenticated, accountId, getAuthToken, login, isLoading: authLoading } = useAuth();

  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState<string | null>(null);
  const [questions, setQuestions] = useState<WebQuestion[]>([]);
  const [session, setSession] = useState<SessionSummary | null>(null);
  const [openText, setOpenText] = useState('');

  // Auth header for fetches — refreshed on every render against latest token.
  const authHeaders = useCallback((): HeadersInit => {
    const token = getAuthToken();
    const headers: HeadersInit = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return headers;
  }, [getAuthToken]);

  // Persist/recall sid so a page reload mid-quiz resumes in place.
  // Keyed by the person (account), so an account without Farcaster resumes too.
  const storedSidKey = useMemo(() => lsKey(slug, accountId ?? undefined), [slug, accountId]);
  const readStoredSid = useCallback((): string | null => {
    if (!storedSidKey) return null;
    try { return localStorage.getItem(storedSidKey); } catch { return null; }
  }, [storedSidKey]);
  const writeStoredSid = useCallback((sid: string | null) => {
    if (!storedSidKey) return;
    try {
      if (sid) localStorage.setItem(storedSidKey, sid);
      else localStorage.removeItem(storedSidKey);
    } catch { /* ignore */ }
  }, [storedSidKey]);

  // Initial load: only once we have a config + auth state. Auth absent →
  // unauth phase (rendered with a sign-in CTA). Auth present → /web/state.
  useEffect(() => {
    if (!config) {
      setPhase('error');
      setError('Unknown quiz.');
      return;
    }
    if (authLoading) return;
    if (!isAuthenticated || !accountId) {
      setPhase('unauth');
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const sid = readStoredSid();
        const qs = sid ? `?sid=${encodeURIComponent(sid)}` : '';
        const res = await fetch(`${config.apiBase}/state${qs}`, {
          headers: authHeaders(),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error((body as { error?: string }).error || `HTTP ${res.status}`);
        }
        const data = await res.json() as { questions: WebQuestion[]; session: SessionSummary | null };
        if (cancelled) return;
        setQuestions(data.questions);

        if (data.session?.completed) {
          // Already done. Clear the local sid and bounce to the result page.
          writeStoredSid(null);
          navigate(nextPath ?? config.resultPath(data.session.sid), { replace: true });
          return;
        }

        if (data.session && data.session.index > 0) {
          // Resume in place.
          setSession(data.session);
          setPhase('asking');
        } else if (data.session) {
          // Fresh session was already created (e.g. resumed sid at index 0).
          setSession(data.session);
          setPhase('asking');
          writeStoredSid(data.session.sid);
        } else {
          setPhase('intro');
        }
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Failed to load quiz.');
        setPhase('error');
      }
    })();
    return () => { cancelled = true; };
  }, [config, authLoading, isAuthenticated, accountId, readStoredSid, writeStoredSid, authHeaders, navigate, nextPath]);

  const handleStart = useCallback(async () => {
    if (!config) return;
    setPhase('submitting');
    setError(null);
    try {
      const res = await fetch(`${config.apiBase}/start`, {
        method: 'POST',
        headers: authHeaders(),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error || `HTTP ${res.status}`);
      }
      const s = await res.json() as SessionSummary;
      if (s.completed) {
        writeStoredSid(null);
        navigate(nextPath ?? config.resultPath(s.sid), { replace: true });
        return;
      }
      writeStoredSid(s.sid);
      setSession(s);
      setOpenText('');
      setPhase('asking');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start quiz.');
      setPhase('intro');
    }
  }, [config, authHeaders, writeStoredSid, navigate, nextPath]);

  const submitAnswer = useCallback(async (payload: Record<string, unknown>) => {
    if (!config || !session) return;
    setPhase('submitting');
    setError(null);
    try {
      const res = await fetch(`${config.apiBase}/answer`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ sid: session.sid, ...payload }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error || `HTTP ${res.status}`);
      }
      const s = await res.json() as SessionSummary;
      setSession(s);
      setOpenText('');
      if (s.completed) {
        writeStoredSid(null);
        navigate(nextPath ?? config.resultPath(s.sid), { replace: true });
        return;
      }
      setPhase('asking');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to record answer.');
      setPhase('asking');
    }
  }, [config, session, authHeaders, writeStoredSid, navigate, nextPath]);

  // ── Render ─────────────────────────────────────────────────────────

  if (!config) {
    return (
      <>
        <Header />
        <div className="quiz-page quiz-center">
          <AlertCircle />
          <h2>Unknown quiz</h2>
          <p>No quiz named &quot;{slug}&quot; exists. Try /quiz/apperception, /quiz/values, or /quiz/bartlet.</p>
        </div>
      </>
    );
  }

  if (phase === 'loading' || authLoading) {
    return (
      <>
        <Header />
        <div className="quiz-page quiz-center">
          <Loader2 className="quiz-spinner" />
          <p>Loading…</p>
        </div>
      </>
    );
  }

  if (phase === 'unauth') {
    return (
      <>
        <Header />
        <div className="quiz-page quiz-center">
          <h1 className="quiz-title">{config.title}</h1>
          <p className="quiz-tagline">{config.tagline}</p>
          <p className="quiz-byline">by @qbase</p>
          <p>Sign in with Farcaster to take the quiz.</p>
          <button className="quiz-btn quiz-btn-primary" onClick={() => login()}>
            Sign in
          </button>
        </div>
      </>
    );
  }

  if (phase === 'error') {
    return (
      <>
        <Header />
        <div className="quiz-page quiz-center">
          <AlertCircle />
          <h2>Something went wrong</h2>
          <p>{error}</p>
          <button className="quiz-btn" onClick={() => window.location.reload()}>Reload</button>
        </div>
      </>
    );
  }

  if (phase === 'intro') {
    return (
      <>
        <Header />
        <div className="quiz-page quiz-center">
          <h1 className="quiz-title">{config.title}</h1>
          <p className="quiz-tagline">{config.tagline}</p>
          <p className="quiz-byline">{questions.length} questions · by @qbase</p>
          <button className="quiz-btn quiz-btn-primary" onClick={handleStart}>Start</button>
        </div>
      </>
    );
  }

  // asking / submitting — both render the current question; submitting just
  // disables inputs so a double-click doesn't double-post.
  const idx = session?.index ?? 0;
  const total = session?.total ?? questions.length;
  const q = questions[idx];
  const disabled = phase === 'submitting';

  if (!q) {
    return (
      <>
        <Header />
        <div className="quiz-page quiz-center">
          <Loader2 className="quiz-spinner" />
          <p>Loading question…</p>
        </div>
      </>
    );
  }

  return (
    <>
      <Header />
      <div className="quiz-page">
        <div className="quiz-meta">
          <span className="quiz-meta-title">{config.title}</span>
          <span className="quiz-progress">{idx + 1} of {total}</span>
        </div>
        <div className="quiz-progressbar" aria-hidden="true">
          <span style={{ width: `${((idx) / total) * 100}%` }} />
        </div>

        <h2 className="quiz-stem">{q.stem}</h2>

        {error && <p className="quiz-error">{error}</p>}

        {q.type === 'likert' && (
          <div className="quiz-options">
            {LIKERT_LABELS.map((entry) => (
              <button
                key={entry.position}
                disabled={disabled}
                className="quiz-btn quiz-btn-option"
                onClick={() => submitAnswer({ position: entry.position })}
              >
                {entry.label}
              </button>
            ))}
          </div>
        )}

        {(q.type === 'forced' || q.type === 'mc') && (
          <div className="quiz-options">
            {q.a_options.map((opt, i) => (
              <button
                key={`${opt.label}-${i}`}
                disabled={disabled}
                className="quiz-btn quiz-btn-option"
                onClick={() => submitAnswer({ optionIndex: i })}
              >
                {opt.label}
              </button>
            ))}
          </div>
        )}

        {q.type === 'open' && (
          <form
            className="quiz-options"
            onSubmit={(e) => {
              e.preventDefault();
              if (!disabled) submitAnswer({ text: openText });
            }}
          >
            <textarea
              className="quiz-textarea"
              value={openText}
              onChange={(e) => setOpenText(e.target.value)}
              placeholder="say a few words…"
              rows={5}
              maxLength={800}
              disabled={disabled}
              autoFocus
            />
            <div className="quiz-textarea-row">
              <button
                type="button"
                disabled={disabled}
                className="quiz-btn quiz-btn-ghost"
                onClick={() => submitAnswer({ text: '' })}
              >
                Skip
              </button>
              <button
                type="submit"
                disabled={disabled || openText.trim().length === 0}
                className="quiz-btn quiz-btn-primary"
              >
                {disabled ? '…' : 'Continue'}
              </button>
            </div>
          </form>
        )}
      </div>
    </>
  );
}
