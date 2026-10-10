/**
 * MyInboxPage — /me/inbox: what your agents asked you (docs/specs/personal-mcp.md §3.3).
 *
 * An agent with one of your keys (/me/access) can ask you questions while it
 * helps you decide something (ask_owner). They wait here. Each ask shows the
 * decision, why the agent needs it and any specifics, then its questions.
 * Questions the agent wrote are visible only to you; existing public
 * questions are answered like anywhere else, Secret by default. The agent
 * reads your answers back only up to its key's ceiling.
 *
 * /me/inbox/:askId is the link ask_owner hands the agent to show in chat: just
 * that ask, and a "back to your chat" line once it's done.
 *
 * Above the asks: answers an agent recorded from a conversation with you
 * (record_answer). They're Secret and marked as the agent's until you confirm,
 * edit or delete them; confirming can also move a public question's answer to
 * Anon or Public.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Inbox, Lock } from 'lucide-react';
import Header from '../components/Header';
import LoadingAnimation from '../components/LoadingAnimation';
import { useAuth } from '../context/AuthContext';
import { apiClient } from '../lib/apiClient';
import './MyQuizAnswersPage.css';
import './MyAccessPage.css';
import './MyInboxPage.css';

type ItemType = 'text' | 'mc' | 'checkbox' | 'scale';
type Tier = 'Secret' | 'Anon' | 'Public';

interface ItemQuestion {
  id: string;
  owner_only: boolean;
  stem: string;
  type: ItemType;
  options: string[] | null;
  scale: { min: number; max: number; labels?: Record<string, string> } | null;
}

interface AskItem {
  position: number;
  question_id: string;
  answered: boolean;
  skipped: boolean;
  question: ItemQuestion | null;
}

interface Ask {
  id: string;
  status: 'pending' | 'answered' | 'declined';
  created_at: number;
  agent: string;
  /** What the asking key can read back; null once the key is gone. */
  agent_reads: { ceiling: Tier; disclosure: 'raw' | 'derived' } | null;
  decision: string;
  why_needed: string;
  note: string | null;
  items: AskItem[];
}

interface Relay {
  answer_id: string;
  kind: 'answer' | 'owner_answer';
  created_at: number;
  ask_id: string | null;
  agent: string;
  question: ItemQuestion | null;
  /** As stored: a choice, choices joined with ", ", a number as a string, or text. Null if it won't open. */
  answer: string | null;
  reasoning: string | null;
}

type AnswerValue = string | string[] | number | null;

const TIER_RANK: Record<Tier, number> = { Public: 0, Anon: 1, Secret: 2 };

const READS_COPY: Record<Tier, string> = {
  Public: 'your Public answers only',
  Anon: 'your Public and Anon answers',
  Secret: 'all your answers, Secret included',
};

function readsLine(reads: Ask['agent_reads']): string {
  if (!reads) return 'This key is gone; nothing you answer here reaches it.';
  if (reads.disclosure === 'derived') return 'This agent sees summaries of your record, not individual answers.';
  return `This agent can read ${READS_COPY[reads.ceiling]}.`;
}

const TIER_COPY: Record<Tier, string> = {
  Secret: 'Secret: you, and agents you allow to read Secret',
  Anon: 'Anon: counts in public results, never with your name',
  Public: 'Public: with your name',
};

export default function MyInboxPage() {
  const navigate = useNavigate();
  const { askId } = useParams<{ askId: string }>();
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const [asks, setAsks] = useState<Ask[] | null>(null);
  const [relays, setRelays] = useState<Relay[]>([]);
  const [showAll, setShowAll] = useState(false);
  const listAll = showAll || !!askId;
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiClient.get(`/api/me/inbox?status=${listAll ? 'all' : 'pending'}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { asks: Ask[]; relays?: Relay[] };
      setAsks(askId ? data.asks.filter((a) => a.id === askId) : data.asks);
      const rs = data.relays ?? [];
      setRelays(askId ? rs.filter((r) => r.ask_id === askId) : rs);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [listAll, askId]);

  useEffect(() => {
    if (authLoading || !isAuthenticated) return;
    void load();
  }, [authLoading, isAuthenticated, load]);

  const decline = async (ask: Ask) => {
    if (!window.confirm(`Decline "${ask.decision}"? ${ask.agent} will see it was declined.`)) return;
    const res = await apiClient.post(`/api/me/inbox/${ask.id}/decline`, {});
    if (res.ok) await load();
  };

  if (!authLoading && !isAuthenticated) {
    return (
      <div className="mqa-page">
        <Header showBack closeButton onBack={() => navigate(-1)} title="inbox" />
        <div className="mqa-container">
          <div className="mqa-empty">
            <Lock size={40} />
            <h2>Sign in to see what your agents asked</h2>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mqa-page">
      <Header showBack closeButton onBack={() => navigate(-1)} title="inbox" />
      <div className="mqa-container">
        <p className="mqa-intro">
          Questions your agents asked you while helping you decide something. Your answers stay in your record, so every agent
          you allow can use them later. <strong>Agents ask; only you answer.</strong>
        </p>
        <div className="mqa-links">
          <Link to="/me/access">agent access →</Link>
          {askId
            ? <Link to="/me/inbox">whole inbox →</Link>
            : <button className="acc-link" onClick={() => setShowAll((v) => !v)}>{showAll ? 'show waiting only' : 'show answered and declined'}</button>}
        </div>

        {askId && asks?.[0] && asks[0].status !== 'pending' && (
          <p className="mqa-intro"><strong>Done.</strong> You can go back to your chat; the agent reads your answers from there.</p>
        )}

        {!error && relays.length > 0 && <RelaysSection relays={relays} onChange={load} />}

        {error ? (
          <div className="mqa-error">Could not load your inbox: {error}</div>
        ) : asks === null ? (
          <div className="mqa-loading"><LoadingAnimation variant="spinner" size="md" /></div>
        ) : asks.length === 0 && relays.length > 0 ? null : asks.length === 0 ? (
          <div className="mqa-empty">
            <Inbox size={40} />
            <p>{askId ? 'No such ask on this account.' : showAll ? 'No agent has asked you anything yet.' : 'Nothing waiting.'}</p>
            <p className="acc-meta">An agent can ask once you give it a key at <Link to="/me/access">agent access</Link>.</p>
          </div>
        ) : (
          asks.map((ask) => <AskCard key={ask.id} ask={ask} onChange={load} onDecline={() => void decline(ask)} />)
        )}
      </div>
    </div>
  );
}

function AskCard({ ask, onChange, onDecline }: { ask: Ask; onChange: () => Promise<void>; onDecline: () => void }) {
  const open = ask.status === 'pending';
  return (
    <div className={`acc-card inb-ask${open ? '' : ' acc-revoked'}`}>
      <div className="acc-head">
        <strong>{ask.decision}</strong>
        <span className="acc-meta">{ask.status === 'pending' ? 'waiting' : ask.status}</span>
      </div>
      <p className="acc-meta">{ask.agent} · {new Date(ask.created_at).toLocaleString()}</p>
      <p className="inb-why"><span>why it asks</span>{ask.why_needed}</p>
      {ask.note && <p className="inb-why"><span>specifics</span>{ask.note}</p>}
      <p className="inb-why"><span>it can read</span>{readsLine(ask.agent_reads)}</p>
      {ask.items.map((it) => (
        <ItemForm key={it.position} askId={ask.id} item={it} reads={ask.agent_reads} disabled={!open} onDone={onChange} />
      ))}
      {open && <button className="acc-link acc-danger" onClick={onDecline}>decline this ask</button>}
    </div>
  );
}

function ItemForm({ askId, item, reads, disabled, onDone }: { askId: string; item: AskItem; reads: Ask['agent_reads']; disabled: boolean; onDone: () => Promise<void> }) {
  const q = item.question;
  const [value, setValue] = useState<AnswerValue>(null);
  const [reasoning, setReasoning] = useState('');
  // Secret by default even when the agent can't read it: sharing more is the owner's call, made below.
  const [tier, setTier] = useState<Tier>('Secret');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!q) return <div className="inb-item"><p className="acc-meta">This question no longer exists.</p></div>;

  const state = item.answered ? 'answered' : item.skipped ? 'skipped' : null;
  if (state || disabled) {
    return (
      <div className="inb-item inb-done">
        <p className="inb-stem">{q.stem}</p>
        <p className="acc-meta">{state ?? 'not answered'}{q.owner_only ? ' · only you see this question' : ''}</p>
      </div>
    );
  }

  const answer = typeof value === 'string' ? value.trim() : value;
  const ready = isReady(answer);

  const post = async (path: string, body?: unknown) => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiClient.post(`/api/me/inbox/${askId}/items/${item.position}${path}`, body ?? {});
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      await onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="inb-item">
      <p className="inb-stem">{q.stem}</p>
      {q.owner_only && <p className="acc-meta"><Lock size={12} /> only you see this question</p>}

      <AnswerFields q={q} name={`${askId}-${item.position}`} value={value} onChange={setValue} />

      <textarea
        className="inb-text inb-reasoning"
        rows={2}
        value={reasoning}
        onChange={(e) => setReasoning(e.target.value)}
        maxLength={2000}
        placeholder="why (optional; this is what agents use most)"
      />

      {!q.owner_only && (
        <fieldset className="acc-field">
          <legend>who sees this answer</legend>
          {(Object.keys(TIER_COPY) as Tier[]).map((t) => (
            <label key={t} className="acc-radio">
              <input type="radio" name={`${askId}-${item.position}-tier`} checked={tier === t} onChange={() => setTier(t)} /> {TIER_COPY[t]}
            </label>
          ))}
          {reads?.disclosure === 'raw' && TIER_RANK[tier] > TIER_RANK[reads.ceiling] && (
            <p className="acc-meta">The agent that asked won't see an answer at this tier.</p>
          )}
        </fieldset>
      )}

      {error && <p className="mqa-error inb-error">{error}</p>}
      <button
        className="acc-button"
        disabled={busy || !ready}
        onClick={() => void post('', { answer, reasoning: reasoning.trim() || undefined, ...(q.owner_only ? {} : { audience: tier }) })}
      >
        save answer
      </button>
      <button className="acc-link inb-skip" disabled={busy} onClick={() => void post('/skip')}>skip</button>
    </div>
  );
}

const isReady = (v: AnswerValue) => (Array.isArray(v) ? v.length > 0 : v !== null && v !== '');

/** The stored answer string back in the shape the inputs (and the API) take. */
function parseStored(q: ItemQuestion, stored: string | null): AnswerValue {
  if (stored === null) return null;
  // Choices are joined with ", " and an option may itself contain one: match whole segments.
  if (q.type === 'checkbox') return (q.options ?? []).filter((o) => `, ${stored}, `.includes(`, ${o}, `));
  if (q.type === 'scale') return Number.isFinite(Number(stored)) ? Number(stored) : null;
  return stored;
}

function AnswerFields({ q, name, value, onChange }: { q: ItemQuestion; name: string; value: AnswerValue; onChange: (v: AnswerValue) => void }) {
  const choices = Array.isArray(value) ? value : [];
  const points = q.scale ? Array.from({ length: q.scale.max - q.scale.min + 1 }, (_, i) => q.scale!.min + i) : [];
  return (
    <>
      {q.type === 'mc' && q.options?.map((o) => (
        <label key={o} className="acc-radio">
          <input type="radio" name={name} checked={value === o} onChange={() => onChange(o)} /> {o}
        </label>
      ))}
      {q.type === 'checkbox' && q.options?.map((o) => (
        <label key={o} className="acc-radio">
          <input
            type="checkbox"
            checked={choices.includes(o)}
            onChange={(e) => onChange(e.target.checked ? [...choices, o] : choices.filter((c) => c !== o))}
          /> {o}
        </label>
      ))}
      {q.type === 'scale' && (
        <div className="inb-scale">
          {points.map((p) => (
            <button key={p} className={`inb-point${value === p ? ' inb-point-on' : ''}`} onClick={() => onChange(p)}>
              {p}
              {q.scale?.labels?.[String(p)] && <small>{q.scale.labels[String(p)]}</small>}
            </button>
          ))}
        </div>
      )}
      {q.type === 'text' && (
        <textarea className="inb-text" rows={3} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} maxLength={2000} placeholder="your answer" />
      )}

    </>
  );
}

function RelaysSection({ relays, onChange }: { relays: Relay[]; onChange: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const confirmAll = async () => {
    setBusy(true);
    try {
      const res = await apiClient.post('/api/me/inbox/relays/confirm-all', {});
      if (res.ok) await onChange();
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="inb-relays">
      <h2 className="mqa-section-title">recorded by your agents, not confirmed</h2>
      <p className="acc-meta">
        An agent wrote these down from a conversation with you. They're Secret, and agents read them as recorded by an agent
        until you confirm them. Nothing is lost if you leave them here.
      </p>
      {relays.length > 1 && (
        <button className="acc-button" disabled={busy} onClick={() => void confirmAll()}>confirm all {relays.length} as recorded</button>
      )}
      {relays.map((r) => <RelayCard key={r.answer_id} relay={r} onChange={onChange} />)}
    </section>
  );
}

function RelayCard({ relay, onChange }: { relay: Relay; onChange: () => Promise<void> }) {
  const q = relay.question;
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState<AnswerValue>(() => (q ? parseStored(q, relay.answer) : null));
  const [reasoning, setReasoning] = useState(relay.reasoning ?? '');
  const [tier, setTier] = useState<Tier>('Secret');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const post = async (path: string, body: unknown) => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiClient.post(`/api/me/inbox/relays/${path}`, body);
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      await onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = () => {
    if (!window.confirm('Delete this recorded answer? Nothing else changes.')) return;
    void post(`${relay.answer_id}/delete`, {});
  };

  const answer = typeof value === 'string' ? value.trim() : value;
  const edits = editing ? { answer, reasoning: reasoning.trim() || null } : {};

  return (
    <div className="acc-card inb-relay">
      <p className="inb-stem">{q?.stem ?? 'a question that no longer exists'}</p>
      <p className="acc-meta">
        {relay.agent} · {new Date(relay.created_at).toLocaleString()}
        {q?.owner_only ? ' · only you see this question' : ''}
      </p>

      {editing && q ? (
        <>
          <AnswerFields q={q} name={`relay-${relay.answer_id}`} value={value} onChange={setValue} />
          <textarea
            className="inb-text inb-reasoning"
            rows={2}
            value={reasoning}
            onChange={(e) => setReasoning(e.target.value)}
            maxLength={2000}
            placeholder="why (optional)"
          />
        </>
      ) : (
        <>
          <p className="inb-relay-answer">{relay.answer ?? 'This answer would not open. Delete it, or edit it to say it again.'}</p>
          {relay.reasoning && <p className="inb-why"><span>why</span>{relay.reasoning}</p>}
        </>
      )}

      {q && !q.owner_only && (
        <fieldset className="acc-field">
          <legend>who sees it once confirmed</legend>
          {(Object.keys(TIER_COPY) as Tier[]).map((t) => (
            <label key={t} className="acc-radio">
              <input type="radio" name={`relay-${relay.answer_id}-tier`} checked={tier === t} onChange={() => setTier(t)} /> {TIER_COPY[t]}
            </label>
          ))}
        </fieldset>
      )}

      {error && <p className="mqa-error inb-error">{error}</p>}
      <div className="inb-relay-actions">
        <button
          className="acc-button"
          disabled={busy || !q || (editing && !isReady(answer)) || (!editing && relay.answer === null)}
          onClick={() => void post(`${relay.answer_id}/confirm`, { ...edits, audience: tier })}
        >
          {editing ? 'save and confirm' : 'confirm'}
        </button>
        {q && <button className="acc-link" disabled={busy} onClick={() => setEditing((v) => !v)}>{editing ? 'cancel edit' : 'edit'}</button>}
        <button className="acc-link acc-danger" disabled={busy} onClick={remove}>delete</button>
      </div>
    </div>
  );
}
