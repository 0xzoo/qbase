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

// Short office labels for the snap. The full names ("Superintendent
// of Public Instruction" = 37 chars) blow past reasonable snap text
// widths and wrap unpredictably on mobile. The snap is a glanceable
// summary; the React result page shows the full names.
const OFFICE_SHORT: Record<string, string> = {
  Governor: 'Governor',
  'Lt. Governor': 'Lt. Governor',
  'Attorney General': 'Atty. General',
  'Secretary of State': 'Sec. of State',
  Controller: 'Controller',
  'Insurance Commissioner': 'Ins. Commissioner',
  Treasurer: 'Treasurer',
  'Superintendent of Public Instruction': 'Superintendent',
};

// Per-office row. 2-line format:
//   line 1: office name (short)
//   line 2: "Candidate · NN% on axis"
// Candidate names already carry the party label ("Porter (D)"),
// so we don't re-append it. The reason axis comes from topReason
// (e.g. "closest match: housing") — we strip the "closest match: "
// prefix since it's redundant in the snap context (we're already
// showing the match).
function officeRow(office: OfficeMatch): string {
  const pct = Math.round(office.topAlignment * 100);
  if (office.allRanked.length === 0) {
    return `${OFFICE_SHORT[office.name] ?? office.name}\nno candidates in your filter`;
  }
  const axis = office.topReason.replace(/^closest match:\s*/i, '');
  return `${OFFICE_SHORT[office.name] ?? office.name}\n${office.topCandidate} · ${pct}% on ${axis}`;
}

export function resultSnap(
  sid: string,
  result: CaSlateResult,
  origin: string,
  miniappOrigin: string
): SnapResponse {
  // Full 8-office breakdown lives IN the snap; the 'View full result'
  // button additionally launches the richer /ca-slate/result mini-app page
  // (per-office candidate rankings + 13-dim profile) for users who want it.
  // The user gets a complete answer in the snap either way.
  //
  // Layout — root has 5 children (under the 7-child root cap):
  //   1. header (text)
  //   2. party_badge (badge)
  //   3. offices_top (sub-stack, 4 text children — first 4 offices)
  //   4. offices_bottom (sub-stack, 4 text children — last 4 offices)
  //   5. button_stack (horizontal, 2 buttons)
  // Splitting the 8 offices into two 4-row sub-stacks keeps each
  // container at exactly 4 children (well under the 6-non-root cap)
  // and breaks the visual mass into two readable blocks instead of
  // one long wall. The warpcast snap 700px hard height limit was
  // being hit by the 3-line-per-office × 8 = 24-line version, which
  // caused the whole snap to fail rendering; the 2-line × 8 = 16
  // line version fits comfortably even with header + badge + buttons.
  //
  // The /ca-slate/result page still exists for users who land on the
  // web version via direct share.
  const shareUrl = `${origin}/snap/ca-slate?share&sid=${encodeURIComponent(sid)}`;
  // 'View full result' must launch as a MINI-APP, not open_url. The result
  // page (/ca-slate/result) fetches the session via sdk.quickAuth.fetch,
  // which only has a Farcaster auth token inside the mini-app host. open_url
  // opens a plain in-app browser with no host context, so the auth'd
  // /api/ca-slate/session call 401s and the page hangs. open_mini_app to the
  // registered miniappOrigin gives the page its auth context — same pattern
  // as values/apperception. (The fc:miniapp meta deep-link 404 that pushed us
  // off open_mini_app was fixed in 23bd751 by dropping the meta tag from
  // /ca-slate/result; the page now falls through to the SPA shell like
  // /values/result.)
  const miniappResultUrl = `${miniappOrigin}/ca-slate/result?sid=${encodeURIComponent(sid)}`;

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

  // Office rows. Each is one text element with 2-line content. Split
  // into two sub-stacks of 4 each so neither container exceeds the
  // 6-non-root-child limit (we use 4 each) and so the user gets two
  // visual blocks rather than one wall of text.
  const topChildren: string[] = [];
  const bottomChildren: string[] = [];
  result.offices.forEach((office, i) => {
    const id = `office_${i}`;
    elements[id] = {
      type: 'text',
      props: { content: officeRow(office), size: 'sm' },
    };
    if (i < 4) topChildren.push(id);
    else bottomChildren.push(id);
  });
  elements.offices_top = {
    type: 'stack',
    props: { direction: 'vertical', gap: 'sm' },
    children: topChildren,
  };
  elements.offices_bottom = {
    type: 'stack',
    props: { direction: 'vertical', gap: 'sm' },
    children: bottomChildren,
  };

  // Action buttons. See full result uses open_url (not open_mini_app)
  // so it bypasses the manifest validation that was 404-ing.
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
      press: { action: 'open_mini_app', params: { target: miniappResultUrl } },
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
    'offices_top',
    'offices_bottom',
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
