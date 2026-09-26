/**
 * MyQuestionAnswers — the "questions" half of /me/answers: every answer you
 * gave outside quizzes, newest first, one per question (and wave), with who
 * can see it and a switch to change that. Values come from GET /api/me/answers
 * (Secret ones opened for you only); a change goes through PUT /api/answers/:id,
 * which keeps the sticky-audience rules and says so when it refuses.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Ghost, Globe, MessageCircleDashed } from 'lucide-react';
import { apiClient } from '../lib/apiClient';
import './MyQuestionAnswers.css';

interface MyAnswer {
  id: string;
  q_id: string;
  stem: string;
  question_type: string | null;
  value: unknown;
  answer_type_id: string | number | null;
  audience: string;
  created_at: string;
  poll_id: string | null;
  earlier: number;
}

type Tier = 'Private' | 'Anon' | 'Public';
const TIERS: Array<{ id: Tier; label: string; hint: string }> = [
  { id: 'Private', label: 'Secret', hint: 'only you and q' },
  { id: 'Anon', label: 'Anon', hint: 'counts, without your name' },
  { id: 'Public', label: 'Public', hint: 'with your name' },
];

function TierIcon({ audience }: { audience: string }) {
  if (audience === 'Anon') return <Ghost size={13} aria-hidden />;
  if (audience === 'Public') return <Globe size={13} aria-hidden />;
  return <MessageCircleDashed size={13} aria-hidden />;
}

function display(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.join(', ');
  return JSON.stringify(value);
}

export default function MyQuestionAnswers() {
  const [answers, setAnswers] = useState<MyAnswer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const res = await apiClient.get('/api/me/answers');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setAnswers(((await res.json()) as { answers: MyAnswer[] }).answers);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const rescope = async (a: MyAnswer, to: Tier) => {
    if (to === a.audience || busy) return;
    setBusy(a.id);
    setNotice(n => ({ ...n, [a.id]: '' }));
    try {
      const res = await apiClient.put(`/api/answers/${a.id}`, {
        value: typeof a.value === 'string' ? a.value : JSON.stringify(a.value),
        audience: to,
        answer_type_id: a.answer_type_id,
      });
      const body = (await res.json().catch(() => ({}))) as { audience?: string; code?: string; error?: string };
      if (!res.ok) {
        setNotice(n => ({
          ...n,
          [a.id]: body.code === 'audience_sticky'
            ? 'Your answers in this poll keep the audience you first chose, so an Anon vote is never linked to your name.'
            : body.error ?? 'Could not change it. Try again.',
        }));
        return;
      }
      setAnswers(list => (list ? list.map(x => (x.id === a.id ? { ...x, audience: body.audience ?? to } : x)) : list));
    } catch {
      setNotice(n => ({ ...n, [a.id]: 'Could not change it. Try again.' }));
    } finally {
      setBusy(null);
    }
  };

  if (error) return <div className="mya-error">Could not load your answers: {error}</div>;
  if (answers === null) return null;
  if (answers.length === 0) {
    return (
      <div className="mya-empty">
        <p>No answers to questions yet.</p>
        <Link to="/questions">answer one →</Link>
      </div>
    );
  }

  return (
    <ol className="mya-list">
      {answers.map(a => {
        const date = new Date(a.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        return (
          <li key={a.id} className="mya-item">
            <Link to={`/question/${a.q_id}`} className="mya-stem">{a.stem}</Link>
            <div className="mya-answer">
              <TierIcon audience={a.audience} />
              <span className="mya-value">{display(a.value)}</span>
            </div>
            <div className="mya-meta">
              {a.poll_id ? <Link to={`/poll/${a.poll_id}/results`}>poll · {date}</Link> : <span>{date}</span>}
              {a.earlier > 0 && <span> · {a.earlier} earlier</span>}
            </div>
            <div className="mya-tiers" role="group" aria-label="Who can see this answer">
              {TIERS.map(t => (
                <button
                  key={t.id}
                  type="button"
                  title={t.hint}
                  className={`mya-tier${(a.audience === t.id || (t.id === 'Private' && a.audience === 'Allowlist')) ? ' is-active' : ''}`}
                  disabled={busy === a.id}
                  onClick={() => void rescope(a, t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>
            {notice[a.id] && <p className="mya-notice">{notice[a.id]}</p>}
          </li>
        );
      })}
    </ol>
  );
}
