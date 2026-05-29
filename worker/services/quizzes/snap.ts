// /snap/quizzes — index snap renderer. Pure function; no I/O.
//
// One scene only: hero + 3 buttons. Each button submits to that quiz's
// existing `?start=1` POST handler, so the per-quiz state machines stay
// untouched — this snap just routes the user to one of them.
//
// Snap v2 limits respected: root max 7 children (we use 6), button labels
// max 30 chars, theme accent must be in the named palette
// (gray|blue|red|amber|green|teal|purple|pink — not 'violet'; that silently
// fails schema validation and tanks the whole embed).

export const QUIZZES_SNAP_CONTENT_TYPE = 'application/vnd.farcaster.snap+json';

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

// 'blue' is the safe neutral here — purple, red, amber are each owned by one
// of the three quizzes (apperception/values/bartlet), so picking any of them
// would imply primacy. Blue stays out of the way.
const ACCENT = 'blue';

function snapShell(
  elements: Record<string, SnapElement>,
  children: string[],
): SnapResponse {
  elements.page = { type: 'stack', props: { direction: 'vertical' }, children };
  return {
    version: '2.0',
    theme: { accent: ACCENT },
    ui: { root: 'page', elements },
  };
}

export function quizzesIndexSnap(origin: string): SnapResponse {
  // Hero reuses the public /questions.png. When bespoke art lands, swap
  // both this and worker/routes/meta.ts (/quizzes embed) at once so the
  // cast preview and the in-snap hero stay in sync.
  const heroUrl = `${origin}/questions.png`;
  const appUrl = `${origin}/snap/apperception?start=1`;
  const valuesUrl = `${origin}/snap/values?start=1`;
  const bartletUrl = `${origin}/snap/bartlet?start=1`;

  return snapShell(
    {
      hero: {
        type: 'image',
        props: {
          url: heroUrl,
          aspect: '4:3',
          alt: 'three short quizzes — apperception, values, bartlet',
        },
      },
      title: {
        type: 'text',
        props: { content: 'quizzes', weight: 'bold', size: 'xl' },
      },
      subtitle: {
        type: 'text',
        props: {
          content: 'three short quizzes from @qbase. pick one — a few minutes each.',
          size: 'sm',
        },
      },
      app_btn: {
        type: 'button',
        props: { label: 'app·erception · cognitive style', variant: 'primary' },
        on: { press: { action: 'submit', params: { target: appUrl } } },
      },
      values_btn: {
        type: 'button',
        props: { label: 'values · moral shape', variant: 'secondary' },
        on: { press: { action: 'submit', params: { target: valuesUrl } } },
      },
      bartlet_btn: {
        type: 'button',
        props: { label: 'bartlet · farcaster archetype', variant: 'secondary' },
        on: { press: { action: 'submit', params: { target: bartletUrl } } },
      },
    },
    ['hero', 'title', 'subtitle', 'app_btn', 'values_btn', 'bartlet_btn'],
  );
}
