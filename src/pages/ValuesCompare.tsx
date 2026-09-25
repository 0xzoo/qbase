/**
 * /values/compare — values compatibility (docs/quizzes/CONTENT-PLAN.md §7.5,
 * card t_990220e3).
 *
 * Three shapes, by query string:
 *   (none)      → the hub: the signed-in person's own compare link to hand
 *                 out, plus a place to paste a friend's.
 *   ?a=ID       → "@alice wants to compare": the signed-in viewer's latest
 *                 values completion becomes `b`; no completion → take the
 *                 quiz and come back (QuizPage honours `?next=`).
 *   ?a=ID&b=ID  → the comparison itself. Both ids are the capability, so no
 *                 sign-in is needed to view a pair; only the two people in
 *                 it get share buttons.
 *
 * Data: GET /api/values/compare(/me). Open-text answers never appear here.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { sdk } from '@farcaster/miniapp-sdk';
import { Copy, Lock, Share2 } from 'lucide-react';
import Header from '../components/Header';
import LoadingAnimation from '../components/LoadingAnimation';
import ValuesRadar from '../components/ValuesRadar';
import { DIM_LABEL, SPOKE_ORDER, type ValuesAxis } from '../lib/valuesDims';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../hooks/useToast';
import { apiClient } from '../lib/apiClient';
import { buildComposeIntentUrl } from '../lib/clientCast';
import './ValuesResult.css';
import './ValuesCompare.css';

interface Scores {
  autonomy: number;
  care: number;
  openness: number;
  mastery: number;
  universalism: number;
  confidence: number;
}

interface PersonCard {
  completionId: string;
  /** Farcaster fid; null for an account without Farcaster (account-root). */
  fid: number | null;
  username: string | null;
  displayName: string | null;
  pfpUrl: string | null;
  dominant: ValuesAxis;
  secondary: ValuesAxis;
  scores: Scores;
  completedAt: number;
}

interface SharedItem {
  questionId: string;
  stem: string;
  type: 'likert' | 'forced';
  a: string;
  b: string;
  verdict: 'agree' | 'disagree' | 'neutral';
  distance: number;
  surprise: number;
  dims: ValuesAxis[];
}

interface Comparison {
  dims: Array<{ dim: ValuesAxis; a: number; b: number; delta: number }>;
  alignment: number;
  closest: ValuesAxis;
  furthest: ValuesAxis;
  sharedItems: number;
  agreeCount: number;
  disagreeCount: number;
  neutralCount: number;
  agreements: SharedItem[];
  disagreements: SharedItem[];
}

interface Narrative {
  headline: string;
  agreements: string[];
  disagreements: string[];
}

interface CompareOk {
  status: 'ok';
  a: PersonCard;
  b: PersonCard;
  viewer: 'a' | 'b' | null;
  comparison: Comparison;
  narrative: Narrative;
  narrativeSource: 'llm' | 'static';
}

type CompareResponse =
  | CompareOk
  | { status: 'sign_in'; a: PersonCard }
  | { status: 'no_completion'; a: PersonCard }
  | { status: 'self'; a: PersonCard };

interface MyCompletion {
  id: string;
  completedAt: number;
  dominant: ValuesAxis | null;
}

function handle(p: Pick<PersonCard, 'username' | 'displayName' | 'fid'>): string {
  return p.username ? `@${p.username}` : p.displayName || (p.fid != null ? `fid ${p.fid}` : 'someone');
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

function compareUrl(a: string, b?: string): string {
  const qs = new URLSearchParams({ a });
  if (b) qs.set('b', b);
  return `${window.location.origin}/values/compare?${qs.toString()}`;
}

export default function ValuesCompare() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const a = searchParams.get('a');
  const b = searchParams.get('b');
  const { isAuthenticated, isLoading: authLoading, isMiniApp } = useAuth();
  const { showToast } = useToast();

  const [data, setData] = useState<CompareResponse | null>(null);
  const [mine, setMine] = useState<MyCompletion | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // The pair already on screen, so rewriting `?a=` to `?a=&b=` after the
  // server resolved the viewer's side does not fetch (and flash) again.
  const loadedRef = useRef<string | null>(null);

  // A plain fetch when signed out: apiClient treats a 401 as "session
  // expired" and logs the viewer out, and a pair view needs no token.
  const get = useCallback(async (path: string): Promise<Response> => {
    if (isAuthenticated) return apiClient.get(path);
    return fetch(path);
  }, [isAuthenticated]);

  // Pair or single-id view.
  useEffect(() => {
    if (!a || authLoading) return;
    const key = `${a}:${b ?? ''}`;
    if (loadedRef.current === key) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const qs = new URLSearchParams({ a });
        if (b) qs.set('b', b);
        const res = await get(`/api/values/compare?${qs.toString()}`);
        if (res.status === 404) throw new Error('That compare link does not point at a values result. It may have been mistyped.');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as CompareResponse;
        if (cancelled) return;
        if (body.status === 'self') {
          // Your own link: nothing to compare against — show the hub.
          navigate('/values/compare', { replace: true });
          return;
        }
        setData(body);
        loadedRef.current = key;
        if (body.status === 'ok' && !b) {
          // The viewer's side resolved server-side: put it in the URL so the
          // page is the shareable artifact.
          loadedRef.current = `${a}:${body.b.completionId}`;
          setSearchParams({ a, b: body.b.completionId }, { replace: true });
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [a, b, authLoading, get, navigate, setSearchParams]);

  // Hub: the viewer's own completion.
  useEffect(() => {
    if (a || authLoading || !isAuthenticated) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiClient.get('/api/values/compare/me');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { completion: MyCompletion | null };
        if (!cancelled) setMine(body.completion);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [a, authLoading, isAuthenticated]);

  const cast = useCallback(async (text: string, url: string) => {
    if (isMiniApp) {
      try {
        await sdk.actions.composeCast({ text, embeds: [url] });
        return;
      } catch {
        // fall through to the web intent
      }
    }
    window.open(buildComposeIntentUrl(text, url), '_blank', 'noopener,noreferrer');
  }, [isMiniApp]);

  const copy = useCallback(async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      showToast('link copied');
    } catch {
      showToast(url);
    }
  }, [showToast]);

  const title = 'values · compare';

  if (authLoading) {
    return (
      <div className="vc-page">
        <Header showBack onBack={() => navigate(-1)} title={title} />
        <div className="vc-container vc-center"><LoadingAnimation variant="spinner" size="md" /></div>
      </div>
    );
  }

  // ── Hub ──────────────────────────────────────────────────────────────
  if (!a) {
    return (
      <div className="vc-page">
        <Header showBack onBack={() => navigate(-1)} title={title} />
        <div className="vc-container">
          <p className="vc-intro">
            Two values results, side by side: where you line up, where you split, and which of those are a surprise.
            Your link is yours to hand out; whoever opens it compares against their own result.
          </p>
          {!isAuthenticated ? (
            <div className="vc-empty">
              <Lock size={36} />
              <h2>Sign in to get your compare link</h2>
              <p>It points at your own values result, so it needs you.</p>
            </div>
          ) : error ? (
            <div className="vc-error">{error}</div>
          ) : mine === undefined ? (
            <div className="vc-center"><LoadingAnimation variant="spinner" size="md" /></div>
          ) : mine === null ? (
            <div className="vc-empty">
              <h2>Take values first</h2>
              <p>Your compare link is built from your own result. Five minutes.</p>
              <Link className="values-btn values-btn--primary" to={`/quiz/values?next=${encodeURIComponent('/values/compare')}`}>take the quiz</Link>
            </div>
          ) : (
            <HubCard mine={mine} onCopy={copy} onCast={cast} />
          )}
          <PasteLink />
          <FootNote />
        </div>
      </div>
    );
  }

  // ── Single id / pair ─────────────────────────────────────────────────
  return (
    <div className="vc-page">
      <Header showBack onBack={() => navigate(-1)} title={title} />
      <div className="vc-container">
        {error ? (
          <div className="vc-error">{error}</div>
        ) : loading || !data ? (
          <div className="vc-center"><LoadingAnimation variant="spinner" size="md" /></div>
        ) : data.status === 'sign_in' ? (
          <Teaser a={data.a} title="Sign in to compare">
            <p>{handle(data.a)} is <strong>{DIM_LABEL[data.a.dominant].toLowerCase()}-led</strong> on values. Sign in and your own result becomes the other side.</p>
          </Teaser>
        ) : data.status === 'no_completion' ? (
          <Teaser a={data.a} title="Take values, then come back">
            <p>{handle(data.a)} is <strong>{DIM_LABEL[data.a.dominant].toLowerCase()}-led</strong>. You need a values result of your own to compare — five minutes, and this page is waiting.</p>
            <Link className="values-btn values-btn--primary" to={`/quiz/values?next=${encodeURIComponent(`/values/compare?a=${a}`)}`}>take the quiz</Link>
          </Teaser>
        ) : data.status === 'ok' ? (
          <Pair data={data} onCopy={copy} onCast={cast} />
        ) : null}
        <FootNote />
      </div>
    </div>
  );
}

// ─── Pieces ──────────────────────────────────────────────────────────────

function FootNote() {
  return (
    <p className="vc-foot">
      Only people holding these links can open this page. Open-text answers are never shown. Scores are the ones each person saw on their own result.
    </p>
  );
}

function PasteLink() {
  const navigate = useNavigate();
  const [raw, setRaw] = useState('');
  const submit = useCallback(() => {
    try {
      const u = new URL(raw.trim(), window.location.origin);
      const pa = u.searchParams.get('a');
      const pb = u.searchParams.get('b');
      if (!pa) return;
      navigate(`/values/compare?${new URLSearchParams(pb ? { a: pa, b: pb } : { a: pa }).toString()}`);
    } catch {
      // not a URL; ignore
    }
  }, [raw, navigate]);
  return (
    <section className="vc-paste">
      <h3>have a friend's link?</h3>
      <div className="vc-paste-row">
        <input
          type="url"
          inputMode="url"
          placeholder="https://qbase.tech/values/compare?a=…"
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          aria-label="a friend's compare link"
        />
        <button type="button" className="values-btn values-btn--secondary" onClick={submit} disabled={!raw.trim()}>open</button>
      </div>
    </section>
  );
}

function HubCard({ mine, onCopy, onCast }: {
  mine: MyCompletion;
  onCopy: (url: string) => void;
  onCast: (text: string, url: string) => void;
}) {
  const url = compareUrl(mine.id);
  const text = mine.dominant
    ? `i'm ${DIM_LABEL[mine.dominant].toLowerCase()}-led on the values quiz by @qbase — open this to see how we compare`
    : 'compare your values with mine — the values quiz by @qbase';
  return (
    <section className="vc-hub">
      <h3>your compare link</h3>
      <p className="vc-hub-url"><code>{url}</code></p>
      <div className="vc-actions">
        <button type="button" className="values-btn values-btn--primary" onClick={() => onCast(text, url)}>
          <Share2 size={14} /> cast it
        </button>
        <button type="button" className="values-btn values-btn--secondary" onClick={() => onCopy(url)}>
          <Copy size={14} /> copy
        </button>
      </div>
      <p className="vc-hub-hint">
        Anyone who opens it and has a values result sees the two of you side by side, and can share that page back.
        Result from {new Date(mine.completedAt).toLocaleDateString()}.
      </p>
    </section>
  );
}

function Teaser({ a, title, children }: { a: PersonCard; title: string; children: React.ReactNode }) {
  return (
    <section className="vc-teaser">
      <PersonChip p={a} side="a" you={false} />
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function PersonChip({ p, side, you }: { p: PersonCard; side: 'a' | 'b'; you: boolean }) {
  return (
    <div className={`vc-person vc-person--${side}`}>
      {p.pfpUrl ? (
        <img src={p.pfpUrl} alt="" className="vc-pfp" />
      ) : (
        <div className="vc-pfp vc-pfp--blank" aria-hidden="true" />
      )}
      <div className="vc-person-text">
        <div className="vc-person-name">
          {handle(p)}
          {you ? <span className="vc-you">you</span> : null}
        </div>
        <div className="vc-person-dom">{DIM_LABEL[p.dominant].toLowerCase()}-led · {DIM_LABEL[p.secondary].toLowerCase()} second</div>
      </div>
    </div>
  );
}

function Pair({ data, onCopy, onCast }: {
  data: CompareOk;
  onCopy: (url: string) => void;
  onCast: (text: string, url: string) => void;
}) {
  const { a, b, comparison: c, narrative, viewer } = data;
  const decided = c.agreeCount + c.disagreeCount;
  const pairUrl = compareUrl(a.completionId, b.completionId);
  const other = viewer === 'a' ? b : a;
  const ownId = viewer === 'a' ? a.completionId : viewer === 'b' ? b.completionId : null;

  const castText = useMemo(() => {
    if (!viewer) return '';
    const n = decided ? `${c.agreeCount} of ${decided}` : 'no';
    return `me & ${handle(other)} match on ${n} values answers — closest on ${DIM_LABEL[c.closest].toLowerCase()}, furthest on ${DIM_LABEL[c.furthest].toLowerCase()}. values by @qbase`;
  }, [viewer, other, decided, c]);

  const dimsRanked = SPOKE_ORDER.slice().sort(
    (x, y) => Math.abs(c.dims.find((d) => d.dim === x)!.delta) - Math.abs(c.dims.find((d) => d.dim === y)!.delta),
  );

  return (
    <>
      <div className="vc-people">
        <PersonChip p={a} side="a" you={viewer === 'a'} />
        <span className="vc-amp" aria-hidden="true">&amp;</span>
        <PersonChip p={b} side="b" you={viewer === 'b'} />
      </div>

      <ValuesRadar
        scores={a.scores}
        compare={b.scores}
        ariaLabel={`values radar for ${handle(a)} and ${handle(b)}`}
      />
      <div className="vc-legend" aria-hidden="true">
        <span className="vc-legend-a">{handle(a)}</span>
        <span className="vc-legend-b">{handle(b)}</span>
      </div>

      <section className="vc-headline">
        <p>{narrative.headline}</p>
        <p className="vc-stats">
          {decided ? <><strong>{c.agreeCount} of {decided}</strong> answers match</> : <>no decided answers in common yet</>}
          {c.neutralCount ? <> · {c.neutralCount} on the fence</> : null}
          {' · '}<strong>{pct(c.alignment)}</strong> shape overlap
        </p>
      </section>

      <section className="vc-dims">
        <h3>dimension by dimension</h3>
        <ul>
          {dimsRanked.map((dim) => {
            const d = c.dims.find((x) => x.dim === dim)!;
            return (
              <li key={dim} className="vc-dim">
                <div className="vc-dim-head">
                  <span className="vc-dim-name">{DIM_LABEL[dim].toLowerCase()}</span>
                  <span className="vc-dim-gap">{dim === c.closest ? 'closest' : dim === c.furthest ? 'furthest apart' : `${Math.round(Math.abs(d.delta) * 100)} apart`}</span>
                </div>
                <div className="vc-bar" aria-hidden="true">
                  <span className="vc-bar-a" style={{ width: pct(d.a) }} />
                  <span className="vc-bar-b" style={{ width: pct(d.b) }} />
                </div>
                <div className="vc-dim-nums"><span>{Math.round(d.a * 100)}</span><span>{Math.round(d.b * 100)}</span></div>
              </li>
            );
          })}
        </ul>
      </section>

      <ItemList
        title="where you surprisingly agree"
        empty="no shared agreement stood out."
        items={c.agreements}
        lines={narrative.agreements}
        a={a}
        b={b}
      />
      <ItemList
        title="where you surprisingly split"
        empty="no split stood out — you answered alike wherever you both took a side."
        items={c.disagreements}
        lines={narrative.disagreements}
        a={a}
        b={b}
      />

      {viewer ? (
        <section className="vc-actions vc-actions--pair">
          <button type="button" className="values-btn values-btn--primary" onClick={() => onCast(castText, pairUrl)}>
            <Share2 size={14} /> cast this
          </button>
          <button type="button" className="values-btn values-btn--secondary" onClick={() => onCopy(pairUrl)}>
            <Copy size={14} /> copy link
          </button>
          {ownId ? (
            <button type="button" className="values-btn values-btn--secondary" onClick={() => onCopy(compareUrl(ownId))}>
              <Copy size={14} /> copy my own link
            </button>
          ) : null}
        </section>
      ) : (
        <section className="vc-actions vc-actions--pair">
          <Link className="values-btn values-btn--primary" to="/values/compare">compare with your own result</Link>
        </section>
      )}
    </>
  );
}

function ItemList({ title, empty, items, lines, a, b }: {
  title: string;
  empty: string;
  items: SharedItem[];
  lines: string[];
  a: PersonCard;
  b: PersonCard;
}) {
  return (
    <section className="vc-items">
      <h3>{title}</h3>
      {items.length === 0 ? (
        <p className="vc-items-empty">{empty}</p>
      ) : (
        <ol>
          {items.map((it, i) => (
            <li key={it.questionId} className="vc-item">
              <p className="vc-item-stem">“{it.stem}”</p>
              <div className="vc-item-answers">
                <span className="vc-item-a"><b>{handle(a)}</b> {it.type === 'forced' ? `picked “${it.a}”` : it.a}</span>
                <span className="vc-item-b"><b>{handle(b)}</b> {it.type === 'forced' ? `picked “${it.b}”` : it.b}</span>
              </div>
              {lines[i] ? <p className="vc-item-line">{lines[i]}</p> : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
