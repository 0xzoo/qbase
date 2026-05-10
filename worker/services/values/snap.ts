// values — snap scene renderers. Pure functions; no I/O.
// The route calls these with session state loaded from KV.
//
// Three question primitives:
//   likert  → slider (min=1, max=5; submitted as inputs.value)
//   forced  → option buttons (choice encoded in target URL, like bartlet)
//   open    → text input (submitted as inputs.value, max 280 chars)
//
// Snap v2 limits respected (root max 7 children, non-root max 6, max depth
// 4, button labels max 30 chars, height ≤ 500px soft / 700 hard).

import { LIKERT_LABELS, VALUES_LENGTH, valuesQuestions, type ValuesAxis } from './questions';
import { dimNarratives, type ValuesFreeTierResult } from './scoring';

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

const ACCENT = 'blue'; // distinct from bartlet's purple — calmer tone matches the values audience

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

// ─── Intro ───────────────────────────────────────────────────────────────
// Hero hosted under R2 bucket `qbase-images/values/`, served by the
// generalized /r2/* route in worker/routes/users.ts. Upload with
// `wrangler r2 object put qbase-images/values/intro.png --file=… --remote`.

export function introSnap(origin: string): SnapResponse {
  const startUrl = `${origin}/snap/values?start=1`;
  return snapShell(
    {
      hero: {
        type: 'image',
        props: {
          url: `${origin}/r2/values/intro.png`,
          aspect: '4:3',
          alt: 'values — being an examination of five dimensions',
        },
      },
      title: {
        type: 'text',
        props: { content: 'values', weight: 'bold', size: 'xl' },
      },
      subtitle: {
        type: 'text',
        props: {
          content: `${VALUES_LENGTH} questions · find what you weigh — by @qbase`,
          size: 'sm',
        },
      },
      blurb: {
        type: 'text',
        props: {
          content:
            'autonomy, care, openness, mastery, universalism. answers are private — only your result is yours to share.',
          size: 'sm',
        },
      },
      start_btn: {
        type: 'button',
        props: { label: 'Start', variant: 'primary' },
        on: { press: { action: 'submit', params: { target: startUrl } } },
      },
    },
    ['hero', 'title', 'subtitle', 'blurb', 'start_btn']
  );
}

// ─── Question (dispatches by type) ───────────────────────────────────────

export function questionSnap(
  sid: string,
  index: number,
  origin: string
): SnapResponse {
  const q = valuesQuestions[index];
  if (!q) return introSnap(origin);

  const submitUrl = `${origin}/snap/values?sid=${encodeURIComponent(sid)}`;
  const progressEl: SnapElement = {
    type: 'progress',
    props: {
      value: index + 1,
      max: VALUES_LENGTH,
      label: `${index + 1} of ${VALUES_LENGTH}`,
    },
  };
  const stemEl: SnapElement = {
    type: 'text',
    props: { content: q.stem, weight: 'bold', size: 'lg' },
  };

  if (q.type === 'likert') {
    return snapShell(
      {
        progress: progressEl,
        stem: stemEl,
        slider: {
          type: 'slider',
          props: {
            name: 'value',
            min: 1,
            max: 5,
            step: 1,
            defaultValue: 3,
            label: `${LIKERT_LABELS[0]} to ${LIKERT_LABELS[LIKERT_LABELS.length - 1]}`,
            showValue: true,
          },
        },
        submit_btn: {
          type: 'button',
          props: { label: 'Next', variant: 'primary' },
          on: { press: { action: 'submit', params: { target: submitUrl } } },
        },
      },
      ['progress', 'stem', 'slider', 'submit_btn']
    );
  }

  if (q.type === 'forced') {
    // Each option is its own submit button, choice encoded in the target URL
    // — snap's submit action only carries `target`, not form inputs from the
    // button. Same pattern as bartlet.
    const buttonUrl = (label: string) =>
      `${submitUrl}&choice=${encodeURIComponent(label)}`;

    const elements: Record<string, SnapElement> = {
      progress: progressEl,
      stem: stemEl,
    };
    const children: string[] = ['progress', 'stem'];
    q.a_options.forEach((o, i) => {
      const id = `opt_${i}`;
      elements[id] = {
        type: 'button',
        props: { label: o.label, variant: 'secondary' },
        on: { press: { action: 'submit', params: { target: buttonUrl(o.label) } } },
      };
      children.push(id);
    });
    return snapShell(elements, children);
  }

  // open
  return snapShell(
    {
      progress: progressEl,
      stem: stemEl,
      input: {
        type: 'input',
        props: {
          name: 'value',
          type: 'text',
          placeholder: 'a sentence or two…',
          maxLength: 280,
        },
      },
      submit_btn: {
        type: 'button',
        props: { label: 'Next', variant: 'primary' },
        on: { press: { action: 'submit', params: { target: submitUrl } } },
      },
    },
    ['progress', 'stem', 'input', 'submit_btn']
  );
}

// ─── Result ──────────────────────────────────────────────────────────────

const dimLabel: Record<ValuesAxis, string> = {
  autonomy: 'Autonomy',
  care: 'Care',
  openness: 'Openness',
  mastery: 'Mastery',
  universalism: 'Universalism',
};

export type AirdropStatus =
  | { kind: 'success'; txHash: string; amountTokens: string }
  | { kind: 'already_claimed'; txHash: string }
  | { kind: 'pool_exhausted' }
  | { kind: 'not_eligible'; reason: 'score' | 'no_address' }
  | { kind: 'disabled' }
  | { kind: 'pending' };

export function resultSnap(
  sid: string,
  result: ValuesFreeTierResult,
  airdrop: AirdropStatus,
  origin: string,
  miniappOrigin: string
): SnapResponse {
  const dom = dimLabel[result.dominant];
  const sec = dimLabel[result.secondary];
  const badge = `${dom.toUpperCase()}-LED`;
  const shareUrl = `${origin}/snap/values?share=${encodeURIComponent(result.dominant)}`;
  const miniappUrl = `${miniappOrigin}/values/result?sid=${sid}`;

  const elements: Record<string, SnapElement> = {
    badge: {
      type: 'badge',
      props: { label: badge, color: ACCENT },
    },
    secondary_text: {
      type: 'text',
      props: { content: `secondary: ${sec.toLowerCase()}`, size: 'sm' },
    },
    summary: {
      type: 'text',
      props: { content: dimNarratives[result.dominant].summary },
    },
    see_more_btn: {
      type: 'button',
      props: { label: 'See full result', variant: 'primary' },
      on: { press: { action: 'open_mini_app', params: { target: miniappUrl } } },
    },
    share_btn: {
      type: 'button',
      props: { label: 'Share', variant: 'secondary' },
      on: {
        press: {
          action: 'compose_cast',
          params: {
            text: `i'm ${dom.toLowerCase()}-led on the values quiz by @qbase — what are you?`,
            embeds: [shareUrl],
          },
        },
      },
    },
    button_stack: {
      type: 'stack',
      props: { direction: 'horizontal', gap: 'sm' },
      children: ['see_more_btn', 'share_btn'],
    },
  };

  // Stealth-only on the "didn't qualify" paths — say nothing rather than
  // advertising an airdrop the user didn't get. Mirrors bartlet's pattern.
  const airdropEl = airdropBadge(airdrop);
  const rootChildren: string[] = ['badge', 'secondary_text', 'summary'];
  if (airdropEl) {
    elements.airdrop_badge = airdropEl;
    rootChildren.push('airdrop_badge');
  }
  rootChildren.push('button_stack');

  return snapShell(elements, rootChildren);
}

function airdropBadge(airdrop: AirdropStatus): SnapElement | null {
  switch (airdrop.kind) {
    case 'success':
      return {
        type: 'badge',
        props: {
          label: `surprise — you earned ${airdrop.amountTokens} $QQ`,
          color: 'green',
        },
      };
    case 'already_claimed':
      return {
        type: 'badge',
        props: { label: '$QQ already sent for this FID', color: 'gray' },
      };
    case 'pool_exhausted':
    case 'not_eligible':
    case 'disabled':
    case 'pending':
      return null;
  }
}

// ─── Share snap ──────────────────────────────────────────────────────────
// First-person one-liners for the share card. The sharer's followers read
// these, so they're voiced as "i" not "you".

const shareNarratives: Record<ValuesAxis, string> = {
  autonomy: "i run on my own judgment. i'd rather make my own call and learn from it than execute someone else's plan well.",
  care: "the people closest to me factor into almost every choice i make. relationships are the ground all of it sits on.",
  openness: "novelty pulls on me. a strange new direction beats a known good one. i trust the unfolding.",
  mastery: 'i want to get good at the thing — really good. the practice itself is the reward.',
  universalism: "my moral concern extends past the people i know. fairness for strangers, what we leave behind, the long tail.",
};

export function shareSnap(dim: ValuesAxis, origin: string): SnapResponse {
  const startUrl = `${origin}/snap/values?start=1`;
  const label = dimLabel[dim];

  return snapShell(
    {
      header: {
        type: 'stack',
        props: { direction: 'horizontal', justify: 'start', gap: 'sm' },
        children: ['test_name', 'badge'],
      },
      test_name: {
        type: 'text',
        props: { content: 'values', weight: 'bold', size: 'lg' },
      },
      badge: {
        type: 'badge',
        props: { label: `${label.toUpperCase()}-LED`, color: ACCENT },
      },
      summary: {
        type: 'text',
        props: { content: shareNarratives[dim] },
      },
      tagline: {
        type: 'text',
        props: {
          content: `${VALUES_LENGTH} questions · find what you weigh — by @qbase`,
          size: 'sm',
        },
      },
      start_btn: {
        type: 'button',
        props: { label: 'Take the quiz', variant: 'primary' },
        on: { press: { action: 'submit', params: { target: startUrl } } },
      },
    },
    ['header', 'summary', 'tagline', 'start_btn']
  );
}

export function emptyResult(origin: string): SnapResponse {
  return introSnap(origin);
}
