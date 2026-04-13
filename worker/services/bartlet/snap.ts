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
  sid: string,
  result: FreeTierResult,
  airdrop: AirdropStatus,
  origin: string,
  miniappUnlockOrigin: string
): SnapResponse {
  // Snap limits: root max 7 children, non-root max 6 children per stack.
  //
  // Layout: image + badge/runner-up + summary + airdrop badge + buttons.
  // Signature moves are deferred to the miniapp to keep the card compact.
  const pureSymbol = archetypeNarratives[result.dominant].symbol;
  const badge = result.hybrid
    ? result.displayLabel.toUpperCase()
    : `${result.displayLabel.toUpperCase()} ${pureSymbol}`;
  const shareUrl = `${origin}/snap/bartlet?share=${encodeURIComponent(result.displayLabel.toLowerCase())}`;
  const miniappUrl = `${miniappUnlockOrigin}/bartlet/unlock?sid=${sid}`;

  const imageSlug = result.displayLabel.toLowerCase();

  const elements: Record<string, SnapElement> = {};

  // Archetype image
  elements.archetype_img = {
    type: 'image',
    props: {
      url: `${origin}/r2/bartlet/${imageSlug}.png`,
      aspect: '16:9',
      alt: result.displayLabel,
    },
  };

  // Badge + runner-up
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

  // Summary
  elements.summary = { type: 'text', props: { content: result.summary } };

  // Airdrop badge
  const airdropEl = airdropBadge(airdrop);
  if (airdropEl) {
    elements.airdrop_badge = airdropEl;
  }

  // Buttons: Learn More (opens miniapp) + Share
  elements.learn_more_btn = {
    type: 'button',
    props: { label: 'Learn More', variant: 'primary' },
    on: {
      press: {
        action: 'open_mini_app',
        params: { target: miniappUrl },
      },
    },
  };
  elements.share_btn = {
    type: 'button',
    props: { label: 'Share', variant: 'secondary' },
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
  elements.button_stack = {
    type: 'stack',
    props: { direction: 'horizontal', gap: 'sm' },
    children: ['learn_more_btn', 'share_btn'],
  };

  // Root: image, header, summary, [airdrop], buttons — max 5 children
  const rootChildren: string[] = ['archetype_img', 'header_stack', 'summary'];
  if (airdropEl) rootChildren.push('airdrop_badge');
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
