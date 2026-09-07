/**
 * MyQuizReportPage — /me/report
 *
 * The correlation report (docs/quizzes/CONTENT-PLAN.md §7.9, card t_589c4f56):
 * "people who answered like you on X were N× more likely to answer Y". Read
 * from GET /api/me/quiz-report — the cached aggregate intersected with the
 * viewer's own answers. Every line already cleared the server's support and
 * suppression floors; the page only phrases it.
 */

import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Lock } from 'lucide-react';
import Header from '../components/Header';
import LoadingAnimation from '../components/LoadingAnimation';
import { useAuth } from '../context/AuthContext';
import { apiClient } from '../lib/apiClient';
import './MyQuizAnswersPage.css';

interface Side { quiz: string; q_id: string; stem: string; bucket: string }
interface Line {
  x: Side;
  y: Side;
  lift: number;
  share: number;
  base: number;
  n_x: number;
  n_xy: number;
  you: 'same' | 'different' | 'none';
}
interface Report {
  built_at: string;
  users: number;
  users_per_quiz: Record<string, number>;
  quiz_titles: Record<string, string>;
  my_items: number;
  lines: Line[];
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

function liftPhrase(lift: number): { n: string; word: string } {
  return lift >= 1
    ? { n: `${lift.toFixed(1)}×`, word: 'more likely' }
    : { n: `${(1 / lift).toFixed(1)}×`, word: 'less likely' };
}

export default function MyQuizReportPage() {
  const navigate = useNavigate();
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (authLoading || !isAuthenticated) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiClient.get('/api/me/quiz-report');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as Report;
        if (!cancelled) setReport(data);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [authLoading, isAuthenticated]);

  if (!authLoading && !isAuthenticated) {
    return (
      <div className="mqa-page">
        <Header showBack closeButton onBack={() => navigate(-1)} title="your report" />
        <div className="mqa-container">
          <div className="mqa-empty">
            <Lock size={40} />
            <h2>Sign in to read your report</h2>
            <p>It is built from your own quiz answers, which only you and q can read.</p>
          </div>
        </div>
      </div>
    );
  }

  const quizzes = report ? Object.entries(report.users_per_quiz) : [];

  return (
    <div className="mqa-page">
      <Header showBack closeButton onBack={() => navigate(-1)} title="your report" />
      <div className="mqa-container">
        <p className="mqa-intro">
          What your answers say, read against everyone else's. Each line is a real difference in the numbers, never a
          guess: people who answered like you on one question, and what they were more or less likely to say on another.
          Small groups are left out so nobody can be singled out.
        </p>
        <div className="mqa-links">
          <Link to="/me/answers">your answers & visibility →</Link>
          <span aria-hidden="true">·</span>
          <Link to="/quizzes">quizzes</Link>
        </div>

        {error ? (
          <div className="mqa-error">Could not load your report: {error}</div>
        ) : report === null ? (
          <div className="mqa-loading"><LoadingAnimation variant="spinner" size="md" /></div>
        ) : (
          <>
            <p className="mqr-meta">
              built {new Date(report.built_at).toLocaleString()} from {report.users} people
              {quizzes.length ? <> ({quizzes.map(([q, n]) => `${report.quiz_titles[q] ?? q} ${n}`).join(' · ')})</> : null}
            </p>

            {report.my_items === 0 ? (
              <div className="mqa-empty">
                <p>Take a quiz first, then come back: the report reads your own answers.</p>
                <Link to="/quizzes">take one →</Link>
              </div>
            ) : report.lines.length === 0 ? (
              <div className="mqa-empty">
                <p>Not enough people have answered like you yet to say anything true. The report improves with every completion.</p>
              </div>
            ) : (
              report.lines.map((l, i) => {
                const { n, word } = liftPhrase(l.lift);
                return (
                  <article key={`${l.x.q_id}|${l.y.q_id}|${i}`} className="mqr-line">
                    <p className="mqr-claim">
                      People who, like you, answered <strong>{l.x.bucket}</strong> to <em>“{l.x.stem}”</em> were{' '}
                      <span className="mqr-lift">{n}</span> {word} to answer <strong>{l.y.bucket}</strong> to <em>“{l.y.stem}”</em>.
                    </p>
                    <div className="mqr-foot">
                      <span>{pct(l.share)} of them did, vs {pct(l.base)} of everyone</span>
                      <span>·</span>
                      <span>{l.n_xy} of {l.n_x} people</span>
                      <span>·</span>
                      {l.you === 'same' ? (
                        <span className="mqr-you mqr-you-same">you did too</span>
                      ) : l.you === 'different' ? (
                        <span className="mqr-you mqr-you-different">you didn't</span>
                      ) : (
                        <span className="mqr-you">you haven't answered that one</span>
                      )}
                    </div>
                  </article>
                );
              })
            )}
          </>
        )}
      </div>
    </div>
  );
}
