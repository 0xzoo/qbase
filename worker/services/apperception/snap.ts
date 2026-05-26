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

// Snap theme accent must be one of the spec's named palette values
// (gray|blue|red|amber|green|teal|purple|pink). 'violet' is NOT valid and
// makes the whole embed fail schema validation — use 'purple' for the
// apperception identity. See docs.farcaster.xyz/snap.
const ACCENT = 'purple';

// Bump this when shapeImage.ts geometry/labels change. The version goes
// directly into the image URL so CDN/snap-host edge caches treat each
// version as a distinct resource — no manual cache purge needed.
const SHAPE_VERSION = 'v7';

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
// Hero hosted under R2 bucket `qbase-images/apperception/`, served by the
// generalized /r2/* route in worker/routes/users.ts. Upload with
// `wrangler r2 object put qbase-images/apperception/intro-v2.png --file=… --remote`.
// NOTE: the /r2/* route serves `immutable, max-age=1yr`, so bump the filename
// version (intro-v2 → intro-v3 …) when swapping the image — overwriting the
// same key leaves stale copies in client + Farcaster image-proxy caches.

export function introSnap(origin: string): SnapResponse {
  const startUrl = `${origin}/snap/apperception?start=1`;
  return snapShell(
    {
      hero: {
        type: 'image',
        props: {
          url: `${origin}/r2/apperception/intro-v2.png`,
          aspect: '4:3',
          alt: 'app·erception — a self-assembly manual for your mind',
        },
      },
      title: {
        type: 'text',
        props: { content: 'app·erception', weight: 'bold', size: 'xl' },
      },
      subtitle: {
        type: 'text',
        props: {
          content: `${APPERCEPTION_LENGTH} questions · some self-assembly required — by @qbase`,
          size: 'sm',
        },
      },
      blurb: {
        type: 'text',
        props: {
          content:
            'everyone takes in new information differently. find your cognitive style',
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
    // Five labeled buttons (one per Likert point) instead of a slider — a text
    // agree/disagree scale reads clearer as discrete choices. The chosen value
    // (1..5) is encoded in the target URL, same pattern as forced-choice.
    const elements: Record<string, SnapElement> = {
      progress: progressEl,
      stem: stemEl,
    };
    LIKERT_LABELS.forEach((label, i) => {
      elements[`scale_${i}`] = {
        type: 'button',
        props: { label, variant: 'secondary' },
        on: {
          press: {
            action: 'submit',
            params: { target: `${submitUrl}&value=${i + 1}` },
          },
        },
      };
    });
    // Display strongly-agree first (reverse of the disagree→agree label order);
    // each button's value (i+1) stays bound to its true position, so scoring is
    // unaffected. Grouped in a stack to keep the root at 3 children.
    const scaleChildren = LIKERT_LABELS.map((_, i) => `scale_${i}`).reverse();
    elements.scale = {
      type: 'stack',
      props: { direction: 'vertical', gap: 'sm' },
      children: scaleChildren,
    };
    return snapShell(elements, ['progress', 'stem', 'scale']);
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

  // Generic share: intro card. Lead with the op-art hero so the embed has a
  // thumbnail in feed (clients key the preview off the first image element).
  elements.hero = {
    type: 'image',
    props: {
      url: `${effectiveOrigin}/r2/apperception/intro-v2.png`,
      aspect: '4:3',
      alt: 'app·erception — a self-assembly manual for your mind',
    },
  };
  elements.title = {
    type: 'text',
    props: { content: 'app·erception', weight: 'bold', size: 'lg' },
  };
  elements.tagline = {
    type: 'text',
    props: {
      content: `${APPERCEPTION_LENGTH} questions · some self-assembly required — by @qbase`,
      size: 'sm',
    },
  };
  elements.blurb = {
    type: 'text',
    props: {
      content: 'everyone takes in new information differently. find your cognitive style',
      size: 'sm',
    },
  };
  elements.start_btn = {
    type: 'button',
    props: { label: 'Take the quiz', variant: 'primary' },
    on: { press: { action: 'submit', params: { target: startUrl } } },
  };
  return snapShell(elements, ['hero', 'title', 'tagline', 'blurb', 'start_btn']);
}

export function emptyResult(origin: string): SnapResponse {
  return introSnap(origin);
}
