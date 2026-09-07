/**
 * QuizAudienceChooser — who can see the answers of one quiz completion
 * (docs/specs/quiz-answer-audience.md §4.1; cards t_589c4f56 + t_246e760c).
 *
 * One component, two homes: the web result page right after a completion
 * (`variant="result"`, plan V3) and /me/answers for every past completion
 * (`variant="manage"`, plan V2). A three-way choice for the whole quiz —
 * Secret (you + q) · Anon · Public — with the per-answer list one tap away,
 * an in-page confirmation before anything goes Public (webviews suppress
 * window.confirm inconsistently), and the reason inline when an item cannot
 * move: the person already answered that question under another audience,
 * and one person may hold one tallied audience per question.
 *
 * Every change goes through POST /api/me/quiz-answers/:completionId/audience
 * (the ordinary answer re-scope applied to the completion's rows) and the
 * response's final `items` state is what is rendered — no reload. All calls
 * go through apiClient so the component works on the web and in the miniapp.
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { apiClient } from '../../lib/apiClient';
import {
  AUDIENCE_HINT,
  AUDIENCE_LABEL,
  MIXED_HINT,
  QUIZ_AUDIENCES,
  QUIZ_TITLES,
  countsOf,
  dominantAudience,
  formatCompletionDate,
  isQuizAudience,
  outcomeText,
  reasonText,
  type CompletionRef,
  type QuizAudience,
  type QuizCompletionView,
  type RescopeResponse,
} from './quizAudience';
import './QuizAudienceChooser.css';

export type { CompletionRef, QuizCompletionView } from './quizAudience';

interface Props {
  completion: QuizCompletionView;
  variant: 'result' | 'manage';
  /** the completion after a change, for a parent that keeps its own list */
  onChanged?: (next: QuizCompletionView) => void;
}

export default function QuizAudienceChooser({ completion, variant, onChanged }: Props) {
  const [c, setC] = useState<QuizCompletionView>(completion);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{ ids?: string[]; n: number } | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});

  useEffect(() => { setC(completion); }, [completion]);

  const current = dominantAudience(c);
  const title = QUIZ_TITLES[c.quiz_id] ?? c.quiz_id;

  async function apply(audience: QuizAudience, ids?: string[]) {
    setBusy(true);
    setStatus(null);
    try {
      const res = await apiClient.post(`/api/me/quiz-answers/${encodeURIComponent(c.id)}/audience`, { audience, answer_ids: ids });
      const body = (await res.json().catch(() => ({}))) as Partial<RescopeResponse>;
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      const settled: RescopeResponse = {
        changed: body.changed ?? 0,
        unchanged: body.unchanged ?? 0,
        failed: body.failed ?? [],
        items: body.items ?? [],
      };
      const byId = new Map(settled.items.map((i) => [i.id, i.audience]));
      const items = c.items.map((it) => (byId.has(it.id) ? { ...it, audience: byId.get(it.id)! } : it));
      const next: QuizCompletionView = { ...c, items, counts: countsOf(items) };
      setC(next);
      onChanged?.(next);
      const nextReasons: Record<string, string> = {};
      for (const f of settled.failed) nextReasons[f.id] = reasonText(f);
      setReasons(nextReasons);
      setStatus(outcomeText(settled, audience));
      if (settled.failed.length) setOpen(true);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'Could not change visibility.');
    } finally {
      setBusy(false);
    }
  }

  function request(audience: QuizAudience, ids?: string[]) {
    if (audience === 'Public') {
      setConfirm({ ids, n: ids ? ids.length : c.items.length });
      return;
    }
    setConfirm(null);
    void apply(audience, ids);
  }

  const heading = variant === 'result' ? 'Who can see your answers?' : title;
  const sub = variant === 'result'
    ? 'Secret by default — only you and q. Change the whole quiz, or one answer.'
    : `${formatCompletionDate(c.completed_at)}${c.result_category ? ` · you're ${c.result_category}` : ''}`;

  return (
    <section className={`qac qac--${variant}`} aria-busy={busy} aria-label={`visibility of your ${title} answers`}>
      <header className="qac-head">
        {variant === 'result' ? <h3 className="qac-title">{heading}</h3> : <h2 className="qac-title">{heading}</h2>}
        <p className="qac-sub">{sub}</p>
      </header>

      {!c.materialized ? (
        <p className="qac-hint">
          Your answers are still being saved. You can place them any time at <Link to="/me/answers">your answers</Link>.
        </p>
      ) : (
        <>
          <ul className="qac-counts" aria-label="visibility summary">
            {QUIZ_AUDIENCES.filter((a) => c.counts[a]).map((a) => (
              <li key={a} className={`qac-chip qac-chip-${a}`}>{c.counts[a]} {AUDIENCE_LABEL[a].toLowerCase()}</li>
            ))}
            {Object.keys(c.counts).filter((a) => !isQuizAudience(a)).map((a) => (
              <li key={a} className="qac-chip">{c.counts[a]} {a.toLowerCase()}</li>
            ))}
          </ul>

          <div className="qac-seg" role="group" aria-label={`visibility for ${title}`}>
            {QUIZ_AUDIENCES.map((a) => (
              <button
                key={a}
                type="button"
                className={current === a ? `is-active is-${a}` : ''}
                aria-pressed={current === a}
                disabled={busy}
                onClick={() => { if (current !== a) request(a); }}
              >
                {AUDIENCE_LABEL[a]}
              </button>
            ))}
          </div>
          <p className="qac-hint">{current ? AUDIENCE_HINT[current] : MIXED_HINT}</p>

          {confirm ? (
            <div className="qac-confirm" role="alertdialog" aria-label="confirm public">
              <p>
                Attach your name to {confirm.n === 1 ? 'this answer' : `all ${confirm.n} answers`} in {title}?
                {' '}Anyone can see {confirm.n === 1 ? 'it' : 'them'} on the questions.
              </p>
              <div className="qac-confirm-actions">
                <button
                  type="button"
                  className="qac-btn qac-btn--primary"
                  disabled={busy}
                  onClick={() => { const cf = confirm; setConfirm(null); void apply('Public', cf.ids); }}
                >
                  Yes, make {confirm.n === 1 ? 'it' : 'them'} public
                </button>
                <button type="button" className="qac-btn" onClick={() => setConfirm(null)}>Keep as is</button>
              </div>
            </div>
          ) : null}

          {status ? <p className="qac-status" role="status">{status}</p> : null}

          <button type="button" className="qac-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            {open ? 'hide answers' : variant === 'result' ? 'adjust individual answers' : `show ${c.items.length} answers`}
          </button>

          {open ? (
            <ul className="qac-items">
              {c.items.map((it) => (
                <li key={it.id} className="qac-item">
                  <div>
                    <p className="qac-item-stem">{it.stem}</p>
                    <p className={`qac-item-answer ${it.label === null ? 'is-missing' : ''}`}>
                      {it.label ?? (it.error ? 'could not open this answer' : '—')}
                    </p>
                    {reasons[it.id] ? <p className="qac-item-reason">{reasons[it.id]}</p> : null}
                  </div>
                  <select
                    aria-label={`visibility of: ${it.stem}`}
                    value={isQuizAudience(it.audience) ? it.audience : 'Private'}
                    disabled={busy}
                    onChange={(e) => request(e.target.value as QuizAudience, [it.id])}
                  >
                    {QUIZ_AUDIENCES.map((a) => <option key={a} value={a}>{AUDIENCE_LABEL[a]}</option>)}
                  </select>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}

      {variant === 'result' ? (
        <p className="qac-foot"><Link to="/me/answers">manage all your quiz answers →</Link></p>
      ) : null}
    </section>
  );
}

/**
 * The result-page mount: fetch the one completion the session endpoint named
 * and render the chooser for it. Renders nothing while loading, when the
 * session has no completion, or when the fetch fails — the result has
 * already painted and the chooser is never worth an error state there.
 */
export function ResultAudienceBlock({ completion }: { completion: CompletionRef | null | undefined }) {
  const [view, setView] = useState<QuizCompletionView | null>(null);
  const completionId = completion?.id;

  useEffect(() => {
    if (!completionId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiClient.get(`/api/me/quiz-answers?completion_id=${encodeURIComponent(completionId)}`);
        if (!res.ok) return;
        const body = (await res.json()) as { completions: QuizCompletionView[] };
        if (!cancelled) setView(body.completions[0] ?? null);
      } catch {
        /* the result page stands on its own */
      }
    })();
    return () => { cancelled = true; };
  }, [completionId]);

  if (!completionId || !view) return null;
  return <QuizAudienceChooser completion={view} variant="result" />;
}
