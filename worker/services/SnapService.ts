/**
 * Snap rendering for qbase questions.
 *
 * Pure functions that turn query rows into Farcaster Snap JSON responses.
 * No I/O — the route is responsible for DB fetches and HTTP.
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
  a_options?: string | null; // JSON-encoded string[]
  pub_answers?: number | null;
  coiner_fname?: string | null;
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

function authorLine(query: QueryRow): SnapElement | null {
  if (!query.coiner_fname) return null;
  return { type: 'text', props: { content: `asked by @${query.coiner_fname}`, size: 'sm' } };
}

function stemElement(query: QueryRow): SnapElement {
  return { type: 'text', props: { content: query.stem, weight: 'bold', size: 'lg' } };
}

/**
 * Initial render for a question.
 *
 * - MC questions with options → interactive toggle_group + Vote button (posts back
 *   to the same URL; the snap route verifies JFS and records the answer).
 * - Other question types → read-only preview with an "Answer on qbase" deep-link.
 *   In-snap support for scale/text/checkbox is deferred to a later slice.
 */
export function questionToSnap(query: QueryRow, origin: string): SnapResponse {
  const questionUrl = `${origin}/question/${query.id}`;
  const options = parseOptions(query.a_options);
  const answerCount = query.pub_answers ?? 0;
  const isInteractiveMc = query.type === 'mc' && options.length > 0;

  const elements: Record<string, SnapElement> = {};
  const children: string[] = [];

  const author = authorLine(query);
  if (author) {
    elements.author = author;
    children.push('author');
  }

  elements.stem = stemElement(query);
  children.push('stem');

  if (isInteractiveMc) {
    elements.choice = {
      type: 'toggle_group',
      props: {
        name: 'choice',
        options: options.map((label) => ({ value: label, label })),
      },
    };
    children.push('choice');
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

  elements.sep = { type: 'separator', props: {} };
  children.push('sep');

  if (answerCount > 0) {
    elements.count = {
      type: 'badge',
      props: { label: `${answerCount} ${answerCount === 1 ? 'answer' : 'answers'}`, color: 'purple' },
    };
    children.push('count');
  }

  if (isInteractiveMc) {
    elements.vote_btn = {
      type: 'button',
      props: { label: 'Vote', variant: 'primary' },
      on: { press: { action: 'submit', params: { target: questionUrl } } },
    };
    children.push('vote_btn');
  } else {
    elements.open_btn = {
      type: 'button',
      props: { label: 'Answer on qbase', variant: 'primary' },
      on: { press: { action: 'open_url', params: { url: questionUrl } } },
    };
    children.push('open_btn');
  }

  elements.share_btn = {
    type: 'button',
    props: { label: 'Share', variant: 'secondary' },
    on: {
      press: {
        action: 'compose_cast',
        params: { text: query.stem, embeds: [questionUrl] },
      },
    },
  };
  children.push('share_btn');

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

  // Submit target advances qi by one — the POST handler will read `choice`
  // from inputs and apply scoring before rendering the next scene.
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

/**
 * Post-vote results view. Shows aggregate counts as a bar_chart, highlights
 * the user's choice, and offers a Share button that casts the question URL.
 */
export function questionResultsToSnap(
  query: QueryRow,
  counts: Record<string, number>,
  userChoice: string,
  origin: string
): SnapResponse {
  const questionUrl = `${origin}/question/${query.id}`;
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

  const elements: Record<string, SnapElement> = {
    stem: stemElement(query),
    chart: { type: 'bar_chart', props: { bars } },
    your_choice: {
      type: 'badge',
      props: { label: `Your choice: ${userChoice}`, color: 'green' },
    },
    total: {
      type: 'text',
      props: {
        content: `${total} ${total === 1 ? 'vote' : 'votes'} total`,
        size: 'sm',
      },
    },
    sep: { type: 'separator', props: {} },
    share_btn: {
      type: 'button',
      props: { label: 'Share', variant: 'primary' },
      on: {
        press: {
          action: 'compose_cast',
          params: {
            text: `I voted "${userChoice}" on: ${query.stem}`,
            embeds: [questionUrl],
          },
        },
      },
    },
    open_btn: {
      type: 'button',
      props: { label: 'View on qbase', variant: 'secondary' },
      on: { press: { action: 'open_url', params: { url: questionUrl } } },
    },
  };

  const children = ['stem', 'chart', 'your_choice', 'total', 'sep', 'share_btn', 'open_btn'];

  elements.page = { type: 'stack', props: { direction: 'vertical' }, children };

  return {
    version: '2.0',
    theme: { accent: 'purple' },
    ui: { root: 'page', elements },
  };
}
