// bartlet — snap scene renderers. Pure functions; no I/O.
// The route calls these with session state loaded from KV.

import { BARTLET_LENGTH, bartletQuestions } from './questions';
import { archetypeNarratives, type FreeTierResult, type Archetype } from './scoring';

// Hosted under R2 bucket `qbase-images/bartlet/`, served by the generalized
// /r2/* route in worker/routes/users.ts. Upload with
// `wrangler r2 object put qbase-images/bartlet/<name>.png --file=... --remote`.
// Currently used only for intro; result card dropped images to fit under the
// 500px soft limit. Re-add to result when we have a smaller aspect.

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

function snapShell(
  elements: Record<string, SnapElement>,
  children: string[]
): SnapResponse {
  elements.page = { type: 'stack', props: { direction: 'vertical' }, children };
  return {
    version: '2.0',
    theme: { accent: 'purple' },
    ui: { root: 'page', elements },
  };
}

// ─── Intro ───────────────────────────────────────────────────────────────

export function introSnap(origin: string): SnapResponse {
  const startUrl = `${origin}/snap/bartlet?start=1`;
  return snapShell(
    {
      hero: {
        type: 'image',
        props: {
          url: `${origin}/r2/bartlet/intro.png`,
          aspect: '4:3',
          alt: 'bartlet',
        },
      },
      title: {
        type: 'text',
        props: { content: 'bartlet', weight: 'bold', size: 'xl' },
      },
      subtitle: {
        type: 'text',
        props: {
          content: `${BARTLET_LENGTH} questions · find your Farcaster archetype — by @qbase`,
          size: 'sm',
        },
      },
      sep: { type: 'separator', props: {} },
      start_btn: {
        type: 'button',
        props: { label: 'Start', variant: 'primary' },
        on: { press: { action: 'submit', params: { target: startUrl } } },
      },
    },
    ['hero', 'title', 'subtitle', 'sep', 'start_btn']
  );
}

// ─── Question ────────────────────────────────────────────────────────────

export function questionSnap(
  sid: string,
  index: number,
  origin: string
): SnapResponse {
  const q = bartletQuestions[index];
  if (!q) return introSnap(origin);

  // Each option is its own submit button. The chosen option is encoded in
  // the target URL (not inputs) because snap's submit action only carries
  // `target` — there's no way to pre-fill inputs from the button itself.
  const buttonUrl = (label: string) =>
    `${origin}/snap/bartlet?sid=${encodeURIComponent(sid)}&choice=${encodeURIComponent(label)}`;

  const elements: Record<string, SnapElement> = {
    progress: {
      type: 'progress',
      props: {
        value: index + 1,
        max: BARTLET_LENGTH,
        label: `${index + 1} of ${BARTLET_LENGTH}`,
      },
    },
    stem: {
      type: 'text',
      props: { content: q.stem, weight: 'bold', size: 'lg' },
    },
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

// ─── Free result ─────────────────────────────────────────────────────────

export type AirdropStatus =
  | { kind: 'success'; txHash: string; amountTokens: string }
  | { kind: 'not_eligible'; reason: 'score' | 'no_address' }
  | { kind: 'pool_exhausted' }
  | { kind: 'already_claimed'; txHash: string }
  | { kind: 'disabled' }
  | { kind: 'pending' };

export function resultSnap(
  _sid: string,
  result: FreeTierResult,
  airdrop: AirdropStatus,
  origin: string,
  _miniappUnlockOrigin: string
): SnapResponse {
  // Snap limits: root max 7 children, non-root max 6 children per stack.
  // We group related content into sub-stacks to stay under both.
  //
  // Intro is stealth — no $QQ mention anywhere to keep farmers away. The
  // result card IS the reveal: complete the quiz, then discover tokens landed.
  //
  // If the user reads as a hybrid (axis-proximity or diagonal), we swap
  // the image + badge to the hybrid slug. Runner-up still shows the pure
  // dominant + runner-up pair for context.
  const pureSymbol = archetypeNarratives[result.dominant].symbol;
  const badge = result.hybrid
    ? result.displayLabel.toUpperCase()
    : `${result.displayLabel.toUpperCase()} ${pureSymbol}`;
  // Share embeds a share-specific snap that shows the archetype image + a
  // "Take the quiz" button. Single embed, no layout bugs from stacking a
  // raw image + snap.
  const shareUrl = `${origin}/snap/bartlet?share=${encodeURIComponent(result.displayLabel.toLowerCase())}`;

  const elements: Record<string, SnapElement> = {};

  // Group 1: badge + runner-up (images dropped for now — they push the card
  // past the 500px soft limit. Can be added back with a 16:9 aspect + more
  // aggressive content trimming later.)
  elements.archetype_badge = {
    type: 'badge',
    props: { label: badge, color: 'purple' },
  };
  elements.runner_up_text = {
    type: 'text',
    props: {
      content: result.hybrid
        ? `${result.dominant} ${pureSymbol} × ${result.runnerUp} ${archetypeNarratives[result.runnerUp].symbol}`
        : `runner-up: ${result.runnerUp} ${archetypeNarratives[result.runnerUp].symbol}`,
      size: 'sm',
    },
  };
  elements.header_stack = {
    type: 'stack',
    props: { direction: 'vertical', gap: 'sm' },
    children: ['archetype_badge', 'runner_up_text'],
  };

  // Group 2: summary (single element)
  elements.summary = { type: 'text', props: { content: result.summary } };

  // Group 3: signature moves sub-stack (header + up to 3 lines = ≤4 children)
  const sigChildren: string[] = [];
  if (result.signatureAnswers.length > 0) {
    elements.sig_header = {
      type: 'text',
      props: { content: 'your signature moves', size: 'sm', weight: 'bold' },
    };
    sigChildren.push('sig_header');
    result.signatureAnswers.slice(0, 3).forEach((line, i) => {
      const id = `sig_${i}`;
      elements[id] = { type: 'text', props: { content: `— ${line}`, size: 'sm' } };
      sigChildren.push(id);
    });
    elements.sig_stack = {
      type: 'stack',
      props: { direction: 'vertical', gap: 'sm' },
      children: sigChildren,
    };
  }

  // Group 4: airdrop reveal — just the badge, no basescan button. Users who
  // care can find the tx in their wallet.
  const airdropEl = airdropBadge(airdrop);
  if (airdropEl) {
    elements.airdrop_badge = airdropEl;
  }

  // Group 5: share button
  elements.share_btn = {
    type: 'button',
    props: { label: 'Share on Farcaster', variant: 'primary' },
    on: {
      press: {
        action: 'compose_cast',
        params: {
          text: `I'm ${badge} on the bartlet by @qbase — what are you?`,
          embeds: [shareUrl],
        },
      },
    },
  };

  const rootChildren: string[] = ['header_stack', 'summary'];
  if (result.signatureAnswers.length > 0) rootChildren.push('sig_stack');
  if (airdropEl) rootChildren.push('airdrop_badge');
  rootChildren.push('share_btn');

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
      // Stealth on the "you didn't get anything" paths — say nothing rather
      // than advertising the existence of an airdrop the user didn't qualify
      // for. Qualified users get the reveal; everyone else gets a clean card.
      return null;
  }
}

// Stand-in for "dominant archetype unknown" e.g. when session has no answers.
export function emptyResultBadge(origin: string): SnapResponse {
  return introSnap(origin);
}

// ─── Share snap ──────────────────────────────────────────────────────

// First-person one-liners for the share card. The sharer's followers read
// these, so they're voiced as "I" not "you".
const shareNarratives: Record<string, string> = {
  achiever: "i'm here to win — leaderboards, follower count, rewards rank. if it's measurable, i'm measuring it.",
  explorer: "i'm here to figure out how everything works. new features, hidden mechanics, obscure corners of the protocol.",
  killer: "i'm here for the friction. debates, ratios, competitive trading — i want skin in the game.",
  socializer: "i'm here for the people. deep replies, small channels, frens > followers.",
  speedrunner: "i learn systems fast and turn that into visible wins. first to figure it out, first on the leaderboard.",
  agitator: "i bring the heat, but i want an audience for it. the fight is only fun if people are watching.",
  gladiator: "i play to win and i want everyone to see it. the scoreboard and the fight are the same thing.",
  host: "i curate spaces and share what i find. my influence is infrastructural.",
  strategist: "i study the system to gain leverage over other players. i read every doc AND i know every rival.",
  influencer: "i build reputation through relationships. my follower graph is a friend graph.",
};

export function shareSnap(
  displayLabel: string,
  origin: string
): SnapResponse {
  const imageSlug = displayLabel.toLowerCase();
  const startUrl = `${origin}/snap/bartlet?start=1`;
  const narrative = shareNarratives[imageSlug] ?? null;

  const elements: Record<string, SnapElement> = {
    hero: {
      type: 'image',
      props: {
        url: `${origin}/r2/bartlet/${imageSlug}.png`,
        aspect: '4:3',
        alt: displayLabel,
      },
    },
    header: {
      type: 'stack',
      props: { direction: 'horizontal', justify: 'start' },
      children: ['test_name', 'badge'],
    },
    test_name: {
      type: 'text',
      props: { content: 'bartlet', weight: 'bold', size: 'lg' },
    },
    badge: {
      type: 'badge',
      props: { label: displayLabel.toUpperCase(), color: 'purple' },
    },
    start_btn: {
      type: 'button',
      props: { label: 'Take the quiz', variant: 'primary' },
      on: { press: { action: 'submit', params: { target: startUrl } } },
    },
  };
  const children: string[] = ['hero', 'header'];

  if (narrative) {
    elements.summary = { type: 'text', props: { content: narrative } };
    children.push('summary');
  }

  elements.tagline = {
    type: 'text',
    props: {
      content: `${BARTLET_LENGTH} questions · find your Farcaster archetype — by @qbase`,
      size: 'sm',
    },
  };
  children.push('tagline');

  children.push('start_btn');
  return snapShell(elements, children);
}

// Non-user-facing export for type narrowing callers.
export type { Archetype };
