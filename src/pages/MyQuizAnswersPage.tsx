/**
 * MyQuizAnswersPage — /me/answers
 *
 * A person's quiz answers as rows (docs/quizzes/CONTENT-PLAN.md §6 V2, card
 * t_589c4f56; docs/specs/quiz-answer-audience.md §4.3): one QuizAudienceChooser
 * per completion — the three-way default for the whole quiz (Secret (you + q) ·
 * Anon · Public) and the per-answer override. The listing comes from
 * GET /api/me/quiz-answers with values opened server-side for the owner only;
 * every change goes through the chooser's POST and is rendered from the
 * response, so the page never reloads the list after a change.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Lock } from 'lucide-react';
import Header from '../components/Header';
import LoadingAnimation from '../components/LoadingAnimation';
import QuizAudienceChooser, { type QuizCompletionView } from '../components/quiz/QuizAudienceChooser';
import { useAuth } from '../context/AuthContext';
import { apiClient } from '../lib/apiClient';
import './MyQuizAnswersPage.css';

export default function MyQuizAnswersPage() {
  const navigate = useNavigate();
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const [completions, setCompletions] = useState<QuizCompletionView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiClient.get('/api/me/quiz-answers');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { completions: QuizCompletionView[] };
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
          completions.map((c) => (
            <QuizAudienceChooser
              key={c.id}
              completion={c}
              variant="manage"
              onChanged={(next) => setCompletions((list) => (list ? list.map((x) => (x.id === next.id ? next : x)) : list))}
            />
          ))
        )}
      </div>
    </div>
  );
}
