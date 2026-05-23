// apperception — snap scene renderers. Pure functions; no I/O.
// The route handler calls these with session state loaded from KV.
//
// Two question primitives:
//   likert  → slider (min=1, max=5; submitted as inputs.value)
//   forced  → option buttons (choice encoded in target URL, like bartlet/values)
//
// Snap v2 limits respected (root max 7 children, button labels max 30 chars).

import { LIKERT_LABELS, APPERCEPTION_LENGTH, apperceptionQuestions } from './questions';
import { type ApperceptionFreeTierResult } from './scoring';

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

const ACCENT = 'violet';

// Bump this when shapeImage.ts geometry/labels change. The version goes
// directly into the image URL so CDN/snap-host edge caches treat each
// version as a distinct resource — no manual cache purge needed.
const SHAPE_VERSION = 'v1';

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

// ---------- Intro ----------

export function introSnap(origin: string): SnapResponse {
  const startUrl = `${origin}/snap/apperception?start=1`;
  return snapShell(
    {
      title: {
        type: 'text',
        props: { content: 'app·erception', weight: 'bold', size: 'xl' },
      },
      subtitle: {
        type: 'text',
        props: {
          content: `${APPERCEPTION_LENGTH} questions · how you take things in — by @qbase`,
          size: 'sm',
        },
      },
      blurb: {
        type: 'text',
        props: {
          content:
            'examples or principles? think first or jump in? step-by-step or big picture? find your cognitive style.',
          size: 'sm',
        },
      },
      start_btn: {
        type: 'button',
        props: { label: 'Start', variant: 'primary' },
        on: { press: { action: 'submit', params: { target: startUrl } } },
      },
    },
    ['title', 'subtitle', 'blurb', 'start_btn']
  );
}

// ---------- Question ----------

export function questionSnap(
  sid: string,
  index: number,
  origin: string
): SnapResponse {
  const q = apperceptionQuestions[index];
  if (!q) return introSnap(origin);

  const submitUrl = `${origin}/snap/apperception?sid=${encodeURIComponent(sid)}`;
  const progressEl: SnapElement = {
    type: 'progress',
    props: {
      value: index + 1,
      max: APPERCEPTION_LENGTH,
      label: `${index + 1} of ${APPERCEPTION_LENGTH}`,
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

  // forced
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

// ---------- Result ----------

export type AirdropStatus =
  | { kind: 'success'; txHash: string; amountTokens: string }
  | { kind: 'already_claimed'; txHash: string }
  | { kind: 'pool_exhausted' }
  | { kind: 'not_eligible'; reason: 'score' | 'no_address' }
  | { kind: 'disabled' }
  | { kind: 'pending' };

export function resultSnap(
  sid: string,
  result: ApperceptionFreeTierResult,
  airdrop: AirdropStatus,
  origin: string,
  miniappOrigin: string
): SnapResponse {
  const style = result.style.style;
  const conf = result.style.confidence;
  const blended = result.style.blended;
  const miniappUrl = `${miniappOrigin}/apperception/result?sid=${sid}`;
  const shapeUrl = `${origin}/api/apperception/shape/${SHAPE_VERSION}/${encodeURIComponent(sid)}.png`;

  const badgeLabel = blended ? `Leaning ${style}` : style;
  const elements: Record<string, SnapElement> = {
    hero: {
      type: 'image',
      props: {
        url: shapeUrl,
        aspect: '4:3',
        alt: `your cognitive style shape — ${badgeLabel.toLowerCase()}`,
      },
    },
    badge: {
      type: 'badge',
      props: { label: badgeLabel, color: ACCENT },
    },
    confidence: {
      type: 'text',
      props: { content: `${conf} fit`, size: 'sm' },
    },
    summary: {
      type: 'text',
      props: { content: result.summary },
    },
    share_btn: {
      type: 'button',
      props: { label: 'Share', variant: 'secondary' },
      on: {
        press: {
          action: 'compose_cast',
          params: {
            text: `my cognitive style is "${badgeLabel}" on apperception by @qbase — what's yours?`,
            embeds: [`${origin}/snap/apperception?share&sid=${encodeURIComponent(sid)}`],
          },
        },
      },
    },
    see_more_btn: {
      type: 'button',
      props: { label: 'See full result', variant: 'primary' },
      on: { press: { action: 'open_mini_app', params: { target: miniappUrl } } },
    },
    button_stack: {
      type: 'stack',
      props: { direction: 'horizontal', gap: 'sm' },
      children: ['see_more_btn', 'share_btn'],
    },
  };

  const rootChildren: string[] = ['hero', 'badge', 'confidence', 'summary'];

  // Airdrop badge (stealth on non-success)
  const airdropEl = airdropBadge(airdrop);
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
          label: `you earned ${airdrop.amountTokens} $QQ`,
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

// ---------- Share snap ----------

export function shareSnap(
  sidOrOrigin: string,
  origin?: string,
): SnapResponse {
  // Two variants:
  //   shareSnap(sid, origin) — personalized: shows the user's radar + prompt
  //   shareSnap(origin)      — generic: intro card
  const sid = origin ? sidOrOrigin : undefined;
  const effectiveOrigin = origin ?? sidOrOrigin;
  const shapeUrl = sid
    ? `${effectiveOrigin}/api/apperception/shape/${SHAPE_VERSION}/${encodeURIComponent(sid)}.png`
    : undefined;
  const startUrl = `${effectiveOrigin}/snap/apperception`;

  const elements: Record<string, SnapElement> = {};

  if (shapeUrl) {
    // Personalized share: radar image + tagline
    elements.hero = {
      type: 'image',
      props: {
        url: shapeUrl,
        aspect: '4:3',
        alt: 'apperception cognitive style radar',
      },
    };
    elements.tagline = {
      type: 'text',
      props: {
        content: 'find your cognitive style on app·erception by @qbase',
        size: 'sm',
      },
    };
    elements.start_btn = {
      type: 'button',
      props: { label: 'Take the quiz', variant: 'primary' },
      on: { press: { action: 'submit', params: { target: startUrl } } },
    };
    return snapShell(elements, ['hero', 'tagline', 'start_btn']);
  }

  // Generic share: intro card
  elements.title = {
    type: 'text',
    props: { content: 'app·erception', weight: 'bold', size: 'lg' },
  };
  elements.tagline = {
    type: 'text',
    props: {
      content: `${APPERCEPTION_LENGTH} questions · how you take things in — by @qbase`,
      size: 'sm',
    },
  };
  elements.blurb = {
    type: 'text',
    props: {
      content: 'examples or principles? think first or jump in? step-by-step or big picture?',
      size: 'sm',
    },
  };
  elements.start_btn = {
    type: 'button',
    props: { label: 'Take the quiz', variant: 'primary' },
    on: { press: { action: 'submit', params: { target: startUrl } } },
  };
  return snapShell(elements, ['title', 'tagline', 'blurb', 'start_btn']);
}

export function emptyResult(origin: string): SnapResponse {
  return introSnap(origin);
}
