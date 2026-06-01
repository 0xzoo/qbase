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
import { type CaSlateResult } from './scoring';

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
  // Buttons are primary (not secondary like the party Q) because a
  // Likert commit is a position-statement, while a party filter is a
  // routing choice — different visual weight.
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
      props: { label: LIKERT_LABELS[i], variant: 'primary' },
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

export function resultSnap(
  sid: string,
  result: CaSlateResult,
  origin: string,
  miniappOrigin: string
): SnapResponse {
  // The snap v2 root allows max 7 children. The snap is the door — full
  // 8-card breakdown lives on /ca-slate/result.
  const topMatch = result.offices[0];
  const matchLine = topMatch
    ? `top: ${topMatch.topCandidate} (${Math.round(topMatch.topAlignment * 100)}%)`
    : 'no candidates in your filter';
  const reasonLine = topMatch?.topReason ?? '';

  const miniappUrl = `${miniappOrigin}/ca-slate/result?sid=${encodeURIComponent(sid)}`;
  const shareUrl = `${origin}/snap/ca-slate?share&sid=${encodeURIComponent(sid)}`;

  return snapShell(
    {
      header: {
        type: 'text',
        props: { content: 'your ca slate', weight: 'bold', size: 'xl' },
      },
      party_badge: {
        type: 'badge',
        props: { label: PARTY_LABEL[result.partyChoice], color: ACCENT },
      },
      match_line: {
        type: 'text',
        props: { content: matchLine, size: 'md', weight: 'bold' },
      },
      reason_line: {
        type: 'text',
        props: { content: reasonLine, size: 'sm' },
      },
      source_note: {
        type: 'text',
        props: {
          content: 'publicly sourced scores — see full breakdown in the mini app',
          size: 'sm',
        },
      },
      see_full_btn: {
        type: 'button',
        props: { label: 'See full slate', variant: 'primary' },
        on: {
          press: { action: 'open_mini_app', params: { target: miniappUrl } },
        },
      },
      share_btn: {
        type: 'button',
        props: { label: 'Share', variant: 'secondary' },
        on: {
          press: {
            action: 'compose_cast',
            params: {
              text: 'just took the ca slate quiz on @qbase — my picks across 8 ca offices',
              embeds: [shareUrl],
            },
          },
        },
      },
      button_stack: {
        type: 'stack',
        props: { direction: 'horizontal', gap: 'sm' },
        children: ['see_full_btn', 'share_btn'],
      },
    },
    ['header', 'party_badge', 'match_line', 'reason_line', 'source_note', 'button_stack']
  );
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
