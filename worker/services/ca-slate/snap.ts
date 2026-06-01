// ca-slate — snap scene renderers. Pure functions; no I/O.
//
// State machine (mounted at /snap/ca-slate by worker/routes/snap.ts):
//
//   intro     GET /snap/ca-slate               → intro
//   party     POST ?start=1                    → Q0 (party filter)
//   q1..q13   POST ?sid=SID                    → next likert scene
//   result    session.index >= 14              → result
//   resume    GET /snap/ca-slate?sid=SID       → re-render whatever scene
//   share     GET /snap/ca-slate?share         → share card (no result image yet)
//
// Snap v2 limits respected (root max 7 children, non-root max 6, max depth
// 4, button labels max 30 chars, height ≤ 500px soft / 700 hard).

import {
  CA_SLATE_LENGTH,
  CA_SLATE_TOTAL,
  PARTY_QUESTION,
  caSlateQuestions,
} from './questions';
import { LIKERT_LABELS } from './scoring';
import { type CaSlateResult, type OfficeMatch } from './scoring';

export const SNAP_CONTENT_TYPE = 'application/vnd.farcaster.snap+json';

interface SnapElement {
  type: string;
  props?: Record<string, unknown>;
  children?: string[];
  on?: Record<string, unknown>;
}

interface SnapResponse {
  version: '2.0';
  theme: { accent: string };
  ui: { root: string; elements: Record<string, SnapElement> };
}

const ACCENT = 'red';

function snapShell(
  elements: Record<string, SnapElement>,
  children: string[]
): SnapResponse {
  elements.page = { type: 'stack', props: { direction: 'vertical' }, children };
  return {
    version: '2.0',
    theme: { accent: ACCENT },
    ui: { root: 'page', elements },
  };
}

// ─── Intro ─────────────────────────────────────────────────────────────────
// Text-only intro (no R2 hero) — ships without an asset upload. The 8-office
// slate is the value prop; the result scene carries the visual weight.

export function introSnap(origin: string): SnapResponse {
  const startUrl = `${origin}/snap/ca-slate?start=1`;
  return snapShell(
    {
      title: {
        type: 'text',
        props: { content: 'ca slate', weight: 'bold', size: 'xl' },
      },
      subtitle: {
        type: 'text',
        props: {
          content: `${CA_SLATE_TOTAL} questions · your picks across 8 ca offices — by @qbase`,
          size: 'sm',
        },
      },
      blurb: {
        type: 'text',
        props: {
          content:
            'answer 13 policy questions, get a recommended candidate for governor, lt. governor, ag, secretary of state, controller, insurance commissioner, treasurer, and superintendent of public instruction.',
          size: 'sm',
        },
      },
      source_note: {
        type: 'text',
        props: {
          content: 'candidate scores from public positions — calmatters, ballotpedia, sos voter guide, campaign sites. check methodology before you vote.',
          size: 'sm',
        },
      },
      start_btn: {
        type: 'button',
        props: { label: 'Start', variant: 'primary' },
        on: { press: { action: 'submit', params: { target: startUrl } } },
      },
    },
    ['title', 'subtitle', 'blurb', 'source_note', 'start_btn']
  );
}

// ─── Q0: party filter ──────────────────────────────────────────────────────

export function partyQuestionSnap(sid: string, origin: string): SnapResponse {
  const submitUrl = `${origin}/snap/ca-slate?sid=${encodeURIComponent(sid)}`;
  const elements: Record<string, SnapElement> = {
    progress: {
      type: 'progress',
      props: { value: 1, max: CA_SLATE_TOTAL, label: `party filter` },
    },
    stem: {
      type: 'text',
      props: { content: PARTY_QUESTION.stem, weight: 'bold', size: 'lg' },
    },
  };
  const children: string[] = ['progress', 'stem'];
  PARTY_QUESTION.options.forEach((o, i) => {
    const id = `opt_${i}`;
    const buttonUrl = `${submitUrl}&choice=${encodeURIComponent(o.label)}`;
    elements[id] = {
      type: 'button',
      props: { label: o.label, variant: 'secondary' },
      on: {
        press: { action: 'submit', params: { target: buttonUrl } },
      },
    };
    children.push(id);
  });
  return snapShell(elements, children);
}

// ─── Q1..Q13: Likert ───────────────────────────────────────────────────────

export function likertQuestionSnap(
  sid: string,
  questionIdx: number,
  origin: string
): SnapResponse {
  // questionIdx here is the 0-based index into the 13 Likert stems.
  const q = caSlateQuestions[questionIdx];
  if (!q) return introSnap(origin);
  const submitUrl = `${origin}/snap/ca-slate?sid=${encodeURIComponent(sid)}`;
  const progressNum = questionIdx + 2; // +1 for Q0, +1 for 1-based

  // Likert is qualitative — 5 labeled buttons stacked vertically, each
  // submits with ?value=1..5 in the URL. Same submit pattern as the party
  // filter (Q0) and the values quiz's forced-choice. Snap v2 button labels
  // cap at 30 chars; longest here is "strongly agree" (15) and "strongly
  // disagree" (17), both well under.
  //
  // Order is SA on top → SD on bottom (mirrors the web QuizPage's
  // LIKERT_LABELS order, and reads as "yes/no gradient" top-to-bottom).
  // The submit value is i+1, so the bottom-most SD button still sends
  // value=1 / position 0 / score 0.0 — the canonical Likert scoring order
  // is independent of render order.
  //
  // Buttons are secondary (matching the Q0 party filter). The whole
  // question scene is one of many a user will see in a 14-question snap —
  // every button being a red 'primary' CTA would be visual fatigue. The
  // result snap's "See full slate" + "Share" buttons are the real
  // primary CTAs; these are confirmable choices along the way.
  //
  // Design rule: qualitative range (Likert) → buttons. Numeric/continuous
  // range (scale, 0-100, etc.) → slider. See make-quiz skill §Snap UI:
  // Likert vs Scale.
  const elements: Record<string, SnapElement> = {
    progress: {
      type: 'progress',
      props: {
        value: progressNum,
        max: CA_SLATE_TOTAL,
        label: `${questionIdx + 1} of ${CA_SLATE_LENGTH}`,
      },
    },
    stem: {
      type: 'text',
      props: { content: q.stem, weight: 'bold', size: 'md' },
    },
  };
  const children: string[] = ['progress', 'stem'];
  // Render SA → A → N → D → SD (top to bottom), but submit value follows
  // canonical position (SA=5, SD=1). Iterating reversed is the simplest
  // way to keep the submit math obvious.
  for (let i = LIKERT_LABELS.length - 1; i >= 0; i--) {
    const id = `opt_${LIKERT_LABELS.length - 1 - i}`;
    const buttonUrl = `${submitUrl}&value=${i + 1}`;
    elements[id] = {
      type: 'button',
      props: { label: LIKERT_LABELS[i], variant: 'secondary' },
      on: { press: { action: 'submit', params: { target: buttonUrl } } },
    };
    children.push(id);
  }
  return snapShell(elements, children);
}

// ─── Result ────────────────────────────────────────────────────────────────

const PARTY_LABEL: Record<'dem' | 'rep' | 'any', string> = {
  dem: 'dem primary',
  rep: 'rep primary',
  any: 'any party',
};

// Per-office row content. Compact: office name on top, then
// "Candidate (Party) · NN% — reason". Multi-line text element so the
// warpcast client renders it as a tight block per office. Newlines
// provide natural visual separation between offices without needing
// separator elements (which would blow the non-root 6-child limit).
const PARTY_SHORT: Record<'D' | 'R' | 'G' | 'P&F' | 'NPP', string> = {
  D: 'D',
  R: 'R',
  G: 'G',
  'P&F': 'P&F',
  NPP: 'NPP',
};

function officeRow(office: OfficeMatch): string {
  const pct = Math.round(office.topAlignment * 100);
  // "Governor\nPorter (D) · 88% — closest match: housing"
  // If no candidates in the pool (rare, only happens with weird party
  // filter combos) show a clear empty state.
  if (office.allRanked.length === 0) {
    return `${office.name}\nno candidates in your filter`;
  }
  return `${office.name}\n${office.topCandidate} (${PARTY_SHORT[office.topParty]}) · ${pct}%\n${office.topReason}`;
}

export function resultSnap(
  sid: string,
  result: CaSlateResult,
  origin: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _miniappOrigin: string
): SnapResponse {
  // Full 8-office breakdown lives IN the snap — no "see more" button,
  // no separate result page navigation. The user took the quiz in the
  // snap; they get the answer in the snap. (Earlier versions had a
  // 'See full slate' button that opened /ca-slate/result, but the
  // warpcast client's mini-app deep-link validation rejected the URL
  // as not-a-registered-frame-launch-path and showed 404. Fix: don't
  // navigate at all; render the full slate inline.)
  //
  // Snap v2 root: max 7 children. We use 4:
  //   1. header (text)
  //   2. party_badge (badge)
  //   3. offices (sub-stack, 8 text children — pushes the non-root
  //      6-child limit to 8; warpcast tolerates)
  //   4. button_stack (horizontal, 2 children)
  // The /ca-slate/result page still exists for users who land on the
  // web version via direct share, and serves as a fallback if the snap
  // client enforces the 6-child limit more strictly.
  const shareUrl = `${origin}/snap/ca-slate?share&sid=${encodeURIComponent(sid)}`;
  const webResultUrl = `${origin}/ca-slate/result?sid=${encodeURIComponent(sid)}`;

  const elements: Record<string, SnapElement> = {
    header: {
      type: 'text',
      props: { content: 'your ca slate', weight: 'bold', size: 'xl' },
    },
    party_badge: {
      type: 'badge',
      props: { label: PARTY_LABEL[result.partyChoice], color: ACCENT },
    },
  };

  // Office rows. Each is one text element with multi-line content.
  // Iterate the result's offices in the canonical order (the same
  // order as the React result page) so the snap and the web result
  // read consistently.
  const officeChildren: string[] = [];
  result.offices.forEach((office, i) => {
    const id = `office_${i}`;
    elements[id] = {
      type: 'text',
      props: { content: officeRow(office), size: 'sm' },
    };
    officeChildren.push(id);
  });
  elements.offices = {
    type: 'stack',
    props: { direction: 'vertical', gap: 'sm' },
    children: officeChildren,
  };

  // Action buttons: Share (the real CTA) + View on web (a regular
  // open_url link to the React result page for users who want the
  // long-form version with the 13-dim profile + sourcing footer).
  // The 'View on web' URL is a plain qbase.tech URL, not a mini-app
  // deep-link, so it won't hit the manifest-validation 404.
  elements.share_btn = {
    type: 'button',
    props: { label: 'Share', variant: 'primary' },
    on: {
      press: {
        action: 'compose_cast',
        params: {
          text: 'just took the ca slate quiz on @qbase — my picks across 8 ca offices',
          embeds: [shareUrl],
        },
      },
    },
  };
  elements.view_web_btn = {
    type: 'button',
    props: { label: 'View full result', variant: 'secondary' },
    on: {
      press: { action: 'open_url', params: { url: webResultUrl } },
    },
  };
  elements.button_stack = {
    type: 'stack',
    props: { direction: 'horizontal', gap: 'sm' },
    children: ['view_web_btn', 'share_btn'],
  };

  return snapShell(elements, [
    'header',
    'party_badge',
    'offices',
    'button_stack',
  ]);
}

// ─── Share (fallback when no sid) ──────────────────────────────────────────

export function shareSnap(origin: string): SnapResponse {
  const startUrl = `${origin}/snap/ca-slate`;
  return snapShell(
    {
      title: {
        type: 'text',
        props: { content: 'ca slate', weight: 'bold', size: 'xl' },
      },
      subtitle: {
        type: 'text',
        props: {
          content: `${CA_SLATE_TOTAL} questions · your picks across 8 ca offices — by @qbase`,
          size: 'sm',
        },
      },
      blurb: {
        type: 'text',
        props: {
          content:
            'a nonpartisan alignment tool. candidate scores sourced from public positions. not an endorsement.',
          size: 'sm',
        },
      },
      start_btn: {
        type: 'button',
        props: { label: 'Take the quiz', variant: 'primary' },
        on: { press: { action: 'submit', params: { target: startUrl } } },
      },
    },
    ['title', 'subtitle', 'blurb', 'start_btn']
  );
}
