/**
 * Snap rendering for qbase questions.
 *
 * Pure functions that turn query rows into Farcaster Snap JSON responses.
 * No I/O — the route is responsible for DB fetches and HTTP.
 *
 * Scene 1 (initial): question stem + options (primary) + [Share poll] (secondary) + footer.
 * Scene 2 (results): "You voted/already voted [choice]" + bar chart +
 *   attribution + [Share poll] + [Go to cast].
 *
 * Spec: https://docs.farcaster.xyz/snap
 */

import {
  BARTLET_QUESTIONS,
  BARTLET_LENGTH,
  dominantType,
  writeStateUrl,
  type BartletScores,
} from './BartletQuiz';

export const SNAP_CONTENT_TYPE = 'application/vnd.farcaster.snap+json';

export interface QueryRow {
  id: string;
  stem: string;
  type: string; // 'mc' | 'checkbox' | 'text' | 'scale' | 'scale_range'
  a_options?: string | null;
  pub_answers?: number | null;
  coiner_fname?: string | null;
  cast_hash?: string | null;
  caster_fid?: number | null;
}

interface SnapElement {
  type: string;
  props?: Record<string, unknown>;
  children?: string[];
  on?: Record<string, unknown>;
}

interface SnapResponse {
  version: '2.0';
  theme: { accent: string };
  ui: {
    root: string;
    elements: Record<string, SnapElement>;
  };
}

export function parseOptions(raw?: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((o) => typeof o === 'string') : [];
  } catch {
    return [];
  }
}

function stemElement(query: QueryRow): SnapElement {
  return { type: 'text', props: { content: query.stem, weight: 'bold', size: 'lg' } };
}

function attributionElement(query: QueryRow): SnapElement | null {
  const author = query.coiner_fname;
  if (!author) return null;
  return { type: 'text', props: { content: `asked by @${author} via @qbase`, size: 'sm' } };
}

/**
 * Build a Farcaster cast URL from cast hash.
 */
function castUrl(query: QueryRow): string | null {
  if (!query.cast_hash) return null;
  return `https://farcaster.xyz/~/conversations/${query.cast_hash}`;
}

/**
 * Scene 1 — question + options (primary buttons) + [Share poll] (secondary) + footer.
 */
export function questionToSnap(query: QueryRow, origin: string): SnapResponse {
  const snapSubmitUrl = `${origin}/snap/question/${query.id}`;
  const options = parseOptions(query.a_options);
  const isInteractiveMc = query.type === 'mc' && options.length > 0;

  const elements: Record<string, SnapElement> = {};
  const children: string[] = [];

  elements.stem = stemElement(query);
  children.push('stem');

  if (isInteractiveMc) {
    options.forEach((label, i) => {
      const id = `opt_${i}`;
      const voteUrl = `${snapSubmitUrl}?choice=${encodeURIComponent(label)}`;
      elements[id] = {
        type: 'button',
        props: { label, variant: 'primary' },
        on: { press: { action: 'submit', params: { target: voteUrl } } },
      };
      children.push(id);
    });
  } else if (options.length > 0) {
    options.forEach((label, i) => {
      const id = `opt_${i}`;
      elements[id] = { type: 'item', props: { title: label } };
      children.push(id);
    });
  } else if (query.type === 'scale' || query.type === 'scale_range') {
    elements.hint = { type: 'text', props: { content: 'Open on qbase to answer on the scale', size: 'sm' } };
    children.push('hint');
  } else if (query.type === 'text') {
    elements.hint = { type: 'text', props: { content: 'Open-ended — answer on qbase', size: 'sm' } };
    children.push('hint');
  }

  // Share button — secondary, for people who want to spread the poll
  elements.sep = { type: 'separator', props: {} };
  children.push('sep');

  elements.share_btn = {
    type: 'button',
    props: { label: 'Share poll', variant: 'secondary' },
    on: {
      press: {
        action: 'compose_cast',
        params: {
          text: query.stem,
          embeds: [snapSubmitUrl],
        },
      },
    },
  };
  children.push('share_btn');

  // Footer — vote count + attribution
  const voteCount = query.pub_answers ?? 0;
  const voteLabel = voteCount === 1 ? 'vote' : 'votes';
  elements.footer = {
    type: 'text',
    props: { content: `qbase.tech · ${voteCount} ${voteLabel}`, size: 'sm' },
  };
  children.push('footer');

  elements.page = { type: 'stack', props: { direction: 'vertical' }, children };

  return {
    version: '2.0',
    theme: { accent: 'purple' },
    ui: { root: 'page', elements },
  };
}

/**
 * Scene 2 — results view shown after voting (or when returning).
 *
 * Layout:
 *   "You voted [choice]" or "You already voted [choice]"
 *   bar chart (aggregate results)
 *   "asked by @user via @qbase"
 *   [Share poll]  [Go to cast]
 */
export function questionResultsToSnap(
  query: QueryRow,
  counts: Record<string, number>,
  userChoice: string,
  origin: string,
  alreadyVoted: boolean = false,
): SnapResponse {
  const snapUrl = `${origin}/snap/question/${query.id}`;
  const options = parseOptions(query.a_options);

  // Preserve option order from the query; include any write-in values at the end.
  const ordered = [...options];
  for (const k of Object.keys(counts)) {
    if (!ordered.includes(k)) ordered.push(k);
  }

  const bars = ordered.map((label) => ({
    label: label.slice(0, 40),
    value: counts[label] ?? 0,
  }));

  const total = bars.reduce((s, b) => s + b.value, 0);
  const voteText = alreadyVoted
    ? `You already voted ${userChoice}`
    : `You voted ${userChoice}`;

  const elements: Record<string, SnapElement> = {
    vote_line: {
      type: 'text',
      props: { content: voteText, weight: 'bold', size: 'md' },
    },
    chart: { type: 'bar_chart', props: { bars } },
    total: {
      type: 'text',
      props: { content: `${total} ${total === 1 ? 'vote' : 'votes'}`, size: 'sm' },
    },
  };

  const children: string[] = ['vote_line', 'chart', 'total'];

  const attr = attributionElement(query);
  if (attr) {
    elements.attr = attr;
    children.push('attr');
  }

  elements.sep = { type: 'separator', props: {} };
  children.push('sep');

  // [Share poll] — compose a cast with the snap URL
  elements.share_btn = {
    type: 'button',
    props: { label: 'Share poll', variant: 'primary' },
    on: {
      press: {
        action: 'compose_cast',
        params: {
          text: query.stem,
          embeds: [snapUrl],
        },
      },
    },
  };

  // [Go to cast] — open the original @polls cast
  const targetCastUrl = castUrl(query);
  if (targetCastUrl) {
    elements.cast_btn = {
      type: 'button',
      props: { label: 'Go to cast', variant: 'secondary' },
      on: { press: { action: 'open_url', params: { url: targetCastUrl } } },
    };
  }

  children.push('share_btn');
  if (targetCastUrl) children.push('cast_btn');

  elements.page = { type: 'stack', props: { direction: 'vertical' }, children };

  return {
    version: '2.0',
    theme: { accent: 'purple' },
    ui: { root: 'page', elements },
  };
}

// ─── Bartlet quiz scenes ──────────────────────────────────────────────────

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

export function bartletIntroSnap(origin: string): SnapResponse {
  const startUrl = writeStateUrl(origin, 0, {
    Killer: 0,
    Achiever: 0,
    Explorer: 0,
    Socializer: 0,
  });

  return snapShell(
    {
      title: {
        type: 'text',
        props: { content: 'The Bartlet Test', weight: 'bold', size: 'xl' },
      },
      subtitle: {
        type: 'text',
        props: {
          content: `${BARTLET_LENGTH} questions · discover your Farcaster archetype`,
          size: 'sm',
        },
      },
      blurb: {
        type: 'text',
        props: {
          content:
            'Killer, Achiever, Explorer, or Socializer — which are you?',
        },
      },
      sep: { type: 'separator', props: {} },
      start_btn: {
        type: 'button',
        props: { label: 'Start', variant: 'primary' },
        on: { press: { action: 'submit', params: { target: startUrl } } },
      },
    },
    ['title', 'subtitle', 'blurb', 'sep', 'start_btn']
  );
}

export function bartletQuestionSnap(
  qi: number,
  scores: BartletScores,
  origin: string
): SnapResponse {
  const q = BARTLET_QUESTIONS[qi];
  if (!q) return bartletIntroSnap(origin);

  const nextUrl = writeStateUrl(origin, qi + 1, scores);

  return snapShell(
    {
      progress: {
        type: 'progress',
        props: {
          value: qi + 1,
          max: BARTLET_LENGTH,
          label: `${qi + 1} of ${BARTLET_LENGTH}`,
        },
      },
      stem: {
        type: 'text',
        props: { content: q.stem, weight: 'bold', size: 'lg' },
      },
      choice: {
        type: 'toggle_group',
        props: {
          name: 'choice',
          options: q.options.map((label) => ({ value: label, label })),
        },
      },
      sep: { type: 'separator', props: {} },
      next_btn: {
        type: 'button',
        props: {
          label: qi + 1 === BARTLET_LENGTH ? 'See result' : 'Next',
          variant: 'primary',
        },
        on: { press: { action: 'submit', params: { target: nextUrl } } },
      },
    },
    ['progress', 'stem', 'choice', 'sep', 'next_btn']
  );
}

export function bartletResultSnap(scores: BartletScores, origin: string): SnapResponse {
  const type = dominantType(scores);
  const total = scores.Killer + scores.Achiever + scores.Explorer + scores.Socializer;

  const resultUrl = writeStateUrl(origin, BARTLET_LENGTH, scores);
  const freshUrl = `${origin}/snap/bartle-dev`;

  return snapShell(
    {
      title: {
        type: 'text',
        props: { content: 'Your Bartlet type', size: 'sm' },
      },
      type_badge: {
        type: 'badge',
        props: { label: type, color: 'purple' },
      },
      chart: {
        type: 'bar_chart',
        props: {
          bars: [
            { label: 'Killer', value: scores.Killer },
            { label: 'Achiever', value: scores.Achiever },
            { label: 'Explorer', value: scores.Explorer },
            { label: 'Socializer', value: scores.Socializer },
          ],
        },
      },
      total: {
        type: 'text',
        props: { content: `${total} answers scored`, size: 'sm' },
      },
      sep: { type: 'separator', props: {} },
      share_btn: {
        type: 'button',
        props: { label: 'Share my result', variant: 'primary' },
        on: {
          press: {
            action: 'compose_cast',
            params: {
              text: `I'm a ${type} on the Bartlet Test. What are you?`,
              embeds: [resultUrl],
            },
          },
        },
      },
      retake_btn: {
        type: 'button',
        props: { label: 'Retake', variant: 'secondary' },
        on: { press: { action: 'submit', params: { target: freshUrl } } },
      },
    },
    ['title', 'type_badge', 'chart', 'total', 'sep', 'share_btn', 'retake_btn']
  );
}
