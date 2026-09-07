/**
 * MyQuizAnswersPage — /me/answers
 *
 * A person's quiz answers as rows (docs/quizzes/CONTENT-PLAN.md §6 V2, card
 * t_589c4f56): one card per completion, a three-way default for the whole
 * quiz — Secret (you + q) · Anon · Public — and a per-answer override. Every
 * change goes through POST /api/me/quiz-answers/:completionId/audience, which
 * is the ordinary answer re-scope applied to the completion's rows; the
 * listing comes from GET /api/me/quiz-answers with values opened server-side
 * for the owner only.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ChevronDown, ChevronUp, Lock } from 'lucide-react';
import Header from '../components/Header';
import LoadingAnimation from '../components/LoadingAnimation';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../hooks/useToast';
import { apiClient } from '../lib/apiClient';
import './MyQuizAnswersPage.css';

type Audience = 'Private' | 'Anon' | 'Public';

interface Item {
  id: string;
  q_id: string;
  stem: string;
  kind: 'mc' | 'scale' | 'text';
  audience: string;
  value: string | null;
  label: string | null;
  error?: string;
}

interface Completion {
  id: string;
  quiz_id: string;
  completed_at: number;
  result_category: string | null;
  materialized: boolean;
  counts: Record<string, number>;
  items: Item[];
}

const QUIZ_TITLES: Record<string, string> = {
  bartlet: 'bartlet',
  values: 'values',
  apperception: 'app·erception',
};

const AUDIENCE_LABEL: Record<Audience, string> = {
  Private: 'Secret',
  Anon: 'Anon',
  Public: 'Public',
};

const AUDIENCE_HINT: Record<Audience, string> = {
  Private: 'Secret: only you and q can read these. They still count in your report and in aggregate stats, never with your name.',
  Anon: 'Anon: each answer counts in the public tally of its question, with no name attached.',
  Public: 'Public: each answer appears on the question with your name.',
};

function dominantAudience(c: Completion): Audience | null {
  const entries = Object.entries(c.counts);
  if (entries.length === 0) return null;
  const total = entries.reduce((s, [, n]) => s + n, 0);
  const [top, n] = entries.sort((a, b) => b[1] - a[1])[0];
  return n === total && (top === 'Private' || top === 'Anon' || top === 'Public') ? top : null;
}

function formatDate(ms: number): string {
  try {
    return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

export default function MyQuizAnswersPage() {
  const navigate = useNavigate();
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const { showToast } = useToast();
  const [completions, setCompletions] = useState<Completion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // completion id being changed
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    try {
      const res = await apiClient.get('/api/me/quiz-answers');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { completions: Completion[] };
      setCompletions(data.completions);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (authLoading || !isAuthenticated) return;
    void load();
  }, [authLoading, isAuthenticated, load]);

  const rescope = async (c: Completion, audience: Audience, answerIds?: string[]) => {
    const n = answerIds ? answerIds.length : c.items.length;
    if (audience === 'Public' && !window.confirm(
      `Attach your name to ${n === 1 ? 'this answer' : `all ${n} answers`} in ${QUIZ_TITLES[c.quiz_id] ?? c.quiz_id}? Anyone can see them on the questions.`,
    )) return;
    setBusy(c.id);
    try {
      const res = await apiClient.post(`/api/me/quiz-answers/${c.id}/audience`, { audience, answer_ids: answerIds });
      const body = (await res.json().catch(() => ({}))) as { changed?: number; failed?: unknown[]; error?: string };
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      const failed = body.failed?.length ?? 0;
      showToast(
        failed ? `${body.changed ?? 0} changed, ${failed} failed` : `${body.changed ?? 0} answer${body.changed === 1 ? '' : 's'} now ${AUDIENCE_LABEL[audience]}`,
        failed ? 'error' : 'success',
      );
      await load();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Could not change visibility', 'error');
    } finally {
      setBusy(null);
    }
  };

  if (!authLoading && !isAuthenticated) {
    return (
      <div className="mqa-page">
        <Header showBack closeButton onBack={() => navigate(-1)} title="your answers" />
        <div className="mqa-container">
          <div className="mqa-empty">
            <Lock size={40} />
            <h2>Sign in to see your quiz answers</h2>
            <p>Your answers are Secret by default: only you and q can read them.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mqa-page">
      <Header showBack closeButton onBack={() => navigate(-1)} title="your answers" />
      <div className="mqa-container">
        <p className="mqa-intro">
          Every quiz answer is yours to place. <strong>Secret</strong> is you and q. <strong>Anon</strong> counts in the
          public tally without your name. <strong>Public</strong> puts your name on it. Change a whole quiz at once, or one answer.
        </p>
        <div className="mqa-links">
          <Link to="/me/report">what your answers say →</Link>
          <span aria-hidden="true">·</span>
          <Link to="/quizzes">quizzes</Link>
        </div>

        {error ? (
          <div className="mqa-error">Could not load your answers: {error}</div>
        ) : completions === null ? (
          <div className="mqa-loading"><LoadingAnimation variant="spinner" size="md" /></div>
        ) : completions.length === 0 ? (
          <div className="mqa-empty">
            <p>You haven't taken a quiz yet.</p>
            <Link to="/quizzes">take one →</Link>
          </div>
        ) : (
          completions.map((c) => {
            const current = dominantAudience(c);
            const isOpen = !!open[c.id];
            const isBusy = busy === c.id;
            return (
              <section key={c.id} className="mqa-card" aria-busy={isBusy}>
                <div className="mqa-card-head">
                  <div>
                    <h2 className="mqa-card-title">{QUIZ_TITLES[c.quiz_id] ?? c.quiz_id}</h2>
                    <p className="mqa-card-sub">
                      {formatDate(c.completed_at)}
                      {c.result_category ? <> · you're <strong>{c.result_category}</strong></> : null}
                    </p>
                  </div>
                </div>

                {!c.materialized ? (
                  <p className="mqa-seg-hint">These answers are not available as rows yet. Check back soon.</p>
                ) : (
                  <>
                    <ul className="mqa-counts" aria-label="visibility summary">
                      {(['Private', 'Anon', 'Public'] as Audience[]).filter((a) => c.counts[a]).map((a) => (
                        <li key={a} className={`mqa-chip mqa-chip-${a}`}>{c.counts[a]} {AUDIENCE_LABEL[a].toLowerCase()}</li>
                      ))}
                      {Object.keys(c.counts).filter((a) => a !== 'Private' && a !== 'Anon' && a !== 'Public').map((a) => (
                        <li key={a} className="mqa-chip">{c.counts[a]} {a.toLowerCase()}</li>
                      ))}
                    </ul>

                    <div className="mqa-seg" role="group" aria-label={`visibility for ${QUIZ_TITLES[c.quiz_id] ?? c.quiz_id}`}>
                      {(['Private', 'Anon', 'Public'] as Audience[]).map((a) => (
                        <button
                          key={a}
                          type="button"
                          className={current === a ? 'is-active' : ''}
                          disabled={isBusy}
                          onClick={() => { if (current !== a) void rescope(c, a); }}
                        >
                          {AUDIENCE_LABEL[a]}
                        </button>
                      ))}
                    </div>
                    <p className="mqa-seg-hint">{current ? AUDIENCE_HINT[current] : 'Mixed: some answers are placed differently. Pick one to apply it to the whole quiz.'}</p>

                    <button type="button" className="mqa-toggle" onClick={() => setOpen((o) => ({ ...o, [c.id]: !isOpen }))}>
                      {isOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                      {isOpen ? 'hide answers' : `show ${c.items.length} answers`}
                    </button>

                    {isOpen ? (
                      <ul className="mqa-items">
                        {c.items.map((it) => (
                          <li key={it.id} className="mqa-item">
                            <div>
                              <p className="mqa-item-stem">{it.stem}</p>
                              <p className={`mqa-item-answer ${it.label === null ? 'is-missing' : ''}`}>
                                {it.label ?? (it.error ? 'could not open this answer' : '—')}
                              </p>
                            </div>
                            <select
                              aria-label="visibility of this answer"
                              value={(['Private', 'Anon', 'Public'] as string[]).includes(it.audience) ? it.audience : 'Private'}
                              disabled={isBusy}
                              onChange={(e) => void rescope(c, e.target.value as Audience, [it.id])}
                            >
                              <option value="Private">Secret</option>
                              <option value="Anon">Anon</option>
                              <option value="Public">Public</option>
                            </select>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </>
                )}
              </section>
            );
          })
        )}
      </div>
    </div>
  );
}
