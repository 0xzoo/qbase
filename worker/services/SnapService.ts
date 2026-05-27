/**
 * Snap rendering for qbase questions.
 *
 * Pure functions that turn query rows into Farcaster Snap JSON responses.
 * No I/O — the route is responsible for DB fetches and HTTP.
 *
 * Scene 1 (initial): question stem + options (primary) + [Share question] (secondary) + footer.
 * Scene 2 (results): "You answered/already answered [choice]" + bar chart +
 *   attribution + [Share question] + [Go to cast].
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

// ─── Compact snap token (HMAC-SHA256) ──────────────────────────────────

/**
 * Generate an HMAC-SHA256 token for compact snap URLs.
 * Uses QBASE_SECRET to ensure only server-generated URLs can serve compact snaps.
 */
export async function generateCompactToken(questionId: string, secret: string): Promise<string> {
  if (!secret) return '';  // Graceful fallback — snap route will serve full snap
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(questionId));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}

/**
 * Verify a compact snap token. Constant-time comparison via timing-safe equal.
 */
export async function verifyCompactToken(
  questionId: string,
  token: string,
  secret: string,
): Promise<boolean> {
  const expected = await generateCompactToken(questionId, secret);
  if (expected.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ token.charCodeAt(i);
  }
  return diff === 0;
}

export interface QueryRow {
  id: string;
  stem: string;
  type: string; // 'mc' | 'checkbox' | 'text' | 'scale' | 'scale_range'
  a_options?: string | null;
  scale_config?: string | null;
  pub_answers?: number | null;
  coiner_fname?: string | null;
  cast_hash?: string | null;
  caster_fid?: number | null;
  /** Poll fields. NULL for non-poll questions. */
  closes_at?: string | null;
  eligibility_gate?: string | null;
}

interface SnapElement {
  type: string;
  props?: Record<string, unknown>;
  children?: string[];
  on?: Record<string, unknown>;
}

export interface SnapResponse {
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

// ─── Scale config ────────────────────────────────────────────────────────

export interface ScaleConfig {
  min: number;
  max: number;
  step: number;
  labels?: Record<string, string>; // optional endpoint labels e.g. { "1": "Terrible", "10": "Amazing" }
  customLabels?: { value: number; label: string }[]; // from scale_config column
}

/**
 * Parse a_options as a scale config object.
 * For mc/checkbox, a_options is a string array. For scale, it's an object with min/max/step.
 */
export function parseScaleConfig(raw?: string | null): ScaleConfig | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const min = Number(parsed.min);
      const max = Number(parsed.max);
      const step = Number(parsed.step) || 1;
      if (Number.isFinite(min) && Number.isFinite(max) && min < max) {
        return { min, max, step, labels: parsed.labels ?? undefined, customLabels: parsed.customLabels ?? undefined };
      }
    }
  } catch { /* not valid JSON */ }
  return null;
}

/**
 * Resolve scale config from a QueryRow — tries a_options first, then scale_config column.
 * The creation form saves to scale_config; legacy questions may have it in a_options.
 */
export function resolveScaleConfig(query: QueryRow): ScaleConfig | null {
  return parseScaleConfig(query.a_options) ?? parseScaleConfig(query.scale_config);
}

function stemElement(query: QueryRow): SnapElement {
  return { type: 'text', props: { content: query.stem, weight: 'bold', size: 'lg' } };
}

function audienceToggleElement(): SnapElement {
  return {
    type: 'toggle_group',
    props: {
      name: 'audience',
      options: ['Public', 'Anon'],
      orientation: 'horizontal',
      defaultValue: 'Public',
    },
  };
}

function viewInQbaseButton(queryId: string, origin: string): SnapElement {
  return {
    type: 'button',
    props: { label: 'View in qbase', variant: 'secondary' },
    on: { press: { action: 'open_mini_app', params: { target: `${origin}/question/${queryId}?view=answers` } } },
  };
}

function shareSnapButton(query: QueryRow, origin: string): SnapElement {
  const snapUrl = `${origin}/snap/question/${query.id}`;
  return {
    type: 'button',
    props: { label: 'Share', variant: 'secondary' },
    on: {
      press: {
        action: 'compose_cast',
        params: { text: query.stem, embeds: [snapUrl] },
      },
    },
  };
}

function attributionElement(query: QueryRow): SnapElement | null {
  const author = query.coiner_fname;
  if (!author) return null;
  return { type: 'text', props: { content: `asked by @${author}`, size: 'sm' } };
}

/**
 * Scene 1 — type router. Renders the appropriate snap based on question type.
 *
 * MC (≤6): options as buttons in vertical stack → answer (pagination for >6)
 * Checkbox (≤6): toggle_group(multiple) → submit
 * Text: input + "Reply anonymously..." → Submit + @4n0n cast
 * Scale: slider → submit
 * Scale range / MC (>6) / Checkbox (>6) / unknown: fallback to miniapp
 */
export function questionToSnap(query: QueryRow, origin: string): SnapResponse {
  const options = parseOptions(query.a_options);

  switch (query.type) {
    case 'mc':
      if (options.length > 6) {
        // Pagination needed — caller passes page via URL param (default page 1)
        return mcQuestionToSnapPaged(query, options, origin, 1);
      }
      return mcQuestionToSnap(query, options, origin);

    case 'checkbox':
      if (options.length > 6) return fallbackToMiniapp(query, origin);
      if (options.length === 0) return fallbackToMiniapp(query, origin);
      return checkboxQuestionToSnap(query, options, origin);

    case 'text':
      return textQuestionToSnap(query, origin);

    case 'scale': {
      const config = resolveScaleConfig(query);
      if (!config) return fallbackToMiniapp(query, origin);
      return scaleQuestionToSnap(query, config, origin);
    }

    case 'scale_range':
    default:
      return fallbackToMiniapp(query, origin);
  }
}

/**
 * Strip stem + separator from any snap response.
 * Used by compact mode to remove the question text from scene renders.
 */
export function stripStemFromSnap(snap: SnapResponse): SnapResponse {
  const elements = snap.ui.elements;
  const rootChildren = (elements.page?.children as string[]) ?? [];
  const strippedElements: Record<string, SnapElement> = {};
  const strippedChildren: string[] = [];

  for (const childId of rootChildren) {
    if (childId === 'stem' || childId === 'stem_sep') continue;
    const el = elements[childId];
    if (el) {
      strippedElements[childId] = el;
      strippedChildren.push(childId);
      if (el.children && Array.isArray(el.children)) {
        for (const subChild of el.children as string[]) {
          if (elements[subChild]) {
            strippedElements[subChild] = elements[subChild];
          }
        }
      }
    }
  }

  strippedElements.page = { type: 'stack', props: { direction: 'vertical' }, children: strippedChildren };

  return {
    version: snap.version,
    theme: snap.theme,
    ui: { root: 'page', elements: strippedElements },
  };
}

/**
 * Compact snap — answer input only, no question stem.
 * Reserved for canonical question casts created through qbase (HMAC-gated).
 * Calls the full questionToSnap then strips stem + separator elements.
 */
export function questionToSnapCompact(query: QueryRow, origin: string): SnapResponse {
  const full = questionToSnap(query, origin);

  // If it fell back to miniapp, return as-is (no answer input to show)
  if (query.type === 'scale_range' || query.type === 'default') return full;

  return stripStemFromSnap(full);
}

/**
 * MC question (≤6 options) — options in vertical stack + audience toggle.
 */
function mcQuestionToSnap(query: QueryRow, options: string[], origin: string): SnapResponse {
  const elements: Record<string, SnapElement> = {};
  const children: string[] = [];

  elements.stem = stemElement(query);
  children.push('stem');

  elements.stem_sep = { type: 'separator', props: {} };
  children.push('stem_sep');

  // Audience toggle (horizontal — distinct from vertical options)
  elements.audience = audienceToggleElement();
  children.push('audience');

  // Options in a vertical stack (≤6 children — spec max)
  const snapSubmitUrl = `${origin}/snap/question/${query.id}`;
  const optionIds: string[] = [];
  options.forEach((label, i) => {
    const id = `opt_${i}`;
    const answerUrl = `${snapSubmitUrl}?choice=${encodeURIComponent(label)}`;
    elements[id] = {
      type: 'button',
      props: { label, variant: 'primary' },
      on: { press: { action: 'submit', params: { target: answerUrl } } },
    };
    optionIds.push(id);
  });
  // The Farcaster renderer auto-rows an all-button stack by label length (e.g.
  // 2 short labels like Yes/No → horizontal), ignoring `direction`. A single
  // non-button child makes it honor direction:vertical, so options always stack.
  elements.opt_sep = { type: 'separator', props: {} };
  elements.options_stack = {
    type: 'stack',
    props: { direction: 'vertical', gap: 'sm' },
    children: [...optionIds, 'opt_sep'],
  };
  children.push('options_stack');

  // [Share] [View in qbase] — secondary actions in a horizontal row
  elements.share_btn = shareSnapButton(query, origin);
  elements.view_btn = viewInQbaseButton(query.id, origin);
  elements.share_view_row = {
    type: 'stack',
    props: { direction: 'horizontal', gap: 'md', justify: 'start' },
    children: ['share_btn', 'view_btn'],
  };
  children.push('share_view_row');

  // Footer — answer count only
  const answerCount = query.pub_answers ?? 0;
  const answerLabel = answerCount === 1 ? 'answer' : 'answers';
  elements.footer = {
    type: 'text',
    props: { content: `${answerCount} ${answerLabel}`, size: 'sm' },
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
 * MC question (>6 options) — paginated vertical stack, 6 options per page.
 */
export function mcQuestionToSnapPaged(
  query: QueryRow,
  options: string[],
  origin: string,
  page: number,
  compactSuffix: string = '',
): SnapResponse {
  const PER_PAGE = 6;
  const totalPages = Math.ceil(options.length / PER_PAGE);
  const safePage = Math.max(1, Math.min(page, totalPages));
  const startIdx = (safePage - 1) * PER_PAGE;
  const pageOptions = options.slice(startIdx, startIdx + PER_PAGE);

  const snapSubmitUrl = `${origin}/snap/question/${query.id}`;
  const elements: Record<string, SnapElement> = {};
  const children: string[] = [];

  elements.stem = stemElement(query);
  children.push('stem');

  elements.stem_sep = { type: 'separator', props: {} };
  children.push('stem_sep');

  // Audience toggle (horizontal)
  elements.audience = audienceToggleElement();
  children.push('audience');

  // Options for this page in a vertical stack
  const optionIds: string[] = [];
  pageOptions.forEach((label, i) => {
    const globalIdx = startIdx + i;
    const id = `opt_${globalIdx}`;
    const answerUrl = `${snapSubmitUrl}?choice=${encodeURIComponent(label)}${compactSuffix}`;
    elements[id] = {
      type: 'button',
      props: { label, variant: 'primary' },
      on: { press: { action: 'submit', params: { target: answerUrl } } },
    };
    optionIds.push(id);
  });
  elements.options_stack = {
    type: 'stack',
    props: { direction: 'vertical', gap: 'sm' },
    children: optionIds,
  };
  children.push('options_stack');

  // Pagination buttons
  const paginationIds: string[] = [];
  if (safePage > 1) {
    elements.prev_btn = {
      type: 'button',
      props: { label: '← Back', variant: 'secondary' },
      on: { press: { action: 'submit', params: { target: `${snapSubmitUrl}?page=${safePage - 1}${compactSuffix}` } } },
    };
    paginationIds.push('prev_btn');
  }
  if (safePage < totalPages) {
    elements.next_btn = {
      type: 'button',
      props: { label: 'More options →', variant: 'secondary' },
      on: { press: { action: 'submit', params: { target: `${snapSubmitUrl}?page=${safePage + 1}${compactSuffix}` } } },
    };
    paginationIds.push('next_btn');
  }
  if (paginationIds.length > 0) {
    elements.btn_row = {
      type: 'stack',
      props: { direction: 'horizontal', gap: 'md', justify: 'center' },
      children: paginationIds,
    };
    children.push('btn_row');
  }

  // [Share] [View in qbase] — secondary actions in a horizontal row
  elements.share_btn = shareSnapButton(query, origin);
  elements.view_btn = viewInQbaseButton(query.id, origin);
  elements.share_view_row = {
    type: 'stack',
    props: { direction: 'horizontal', gap: 'md', justify: 'start' },
    children: ['share_btn', 'view_btn'],
  };
  children.push('share_view_row');

  // Footer
  const answerCount = query.pub_answers ?? 0;
  const answerLabel = answerCount === 1 ? 'answer' : 'answers';
  elements.footer = {
    type: 'text',
    props: { content: `${answerCount} ${answerLabel}`, size: 'sm' },
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
 * Text question — input + Submit button. Always anon (no audience toggle).
 */
function textQuestionToSnap(query: QueryRow, origin: string): SnapResponse {
  const elements: Record<string, SnapElement> = {};
  const children: string[] = [];

  elements.stem = stemElement(query);
  children.push('stem');

  elements.stem_sep = { type: 'separator', props: {} };
  children.push('stem_sep');

  elements.input = {
    type: 'input',
    props: {
      name: 'value',
      type: 'text',
      placeholder: 'Reply anonymously...',
      maxLength: 280,
    },
  };
  children.push('input');

  const snapSubmitUrl = `${origin}/snap/question/${query.id}`;
  elements.submit_btn = {
    type: 'button',
    props: { label: 'Submit', variant: 'primary' },
    on: { press: { action: 'submit', params: { target: snapSubmitUrl } } },
  };

  elements.view_btn = viewInQbaseButton(query.id, origin);

  elements.btn_row = {
    type: 'stack',
    props: { direction: 'horizontal', gap: 'md', justify: 'start' },
    children: ['submit_btn', 'view_btn'],
  };
  children.push('btn_row');

  // Footer — answer count only
  const answerCount = query.pub_answers ?? 0;
  const answerLabel = answerCount === 1 ? 'answer' : 'answers';
  elements.footer = {
    type: 'text',
    props: { content: `${answerCount} ${answerLabel}`, size: 'sm' },
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
 * Text submitted — "Answered anonymously!" confirmation.
 */
export function textSubmittedToSnap(query: QueryRow, origin: string): SnapResponse {
  const elements: Record<string, SnapElement> = {};
  const children: string[] = [];

  elements.check = {
    type: 'text',
    props: { content: '✓ Answered anonymously!', weight: 'bold', size: 'md' },
  };
  children.push('check');

  elements.detail = {
    type: 'text',
    props: { content: 'Your answer was posted as a reply from @4n0n', size: 'sm' },
  };
  children.push('detail');

  const answerCount = query.pub_answers ?? 0;
  const answerLabel = answerCount === 1 ? 'answer' : 'answers';

  const snapUrl = `${origin}/snap/question/${query.id}`;
  elements.share_btn = {
    type: 'button',
    props: { label: 'Share', variant: 'primary' },
    on: {
      press: {
        action: 'compose_cast',
        params: { text: query.stem, embeds: [snapUrl] },
      },
    },
  };

  elements.view_btn = {
    type: 'button',
    props: { label: 'View in qbase', variant: 'secondary' },
    on: { press: { action: 'open_mini_app', params: { target: `${origin}/question/${query.id}?view=answers` } } },
  };

  elements.sep = { type: 'separator', props: {} };
  children.push('sep');

  elements.btn_row = {
    type: 'stack',
    props: { direction: 'horizontal', gap: 'md', justify: 'center' },
    children: ['share_btn', 'view_btn'],
  };
  children.push('btn_row');

  elements.footer = {
    type: 'text',
    props: { content: `${answerCount} ${answerLabel}`, size: 'sm' },
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
 * Low-score gate scene — shown when a user tries to answer anonymously
 * but their Neynar trust score is below the minimum threshold.
 */
export function lowScoreSnap(query: QueryRow, origin: string): SnapResponse {
  const elements: Record<string, SnapElement> = {};
  const children: string[] = [];

  elements.header = {
    type: 'text',
    props: { content: '⚠ Account score too low', weight: 'bold', size: 'md' },
  };
  children.push('header');

  elements.detail = {
    type: 'text',
    props: {
      content: 'Anonymous answers require a minimum trust score. Try answering with your identity, or build up your Farcaster reputation first.',
      size: 'sm',
    },
  };
  children.push('detail');

  elements.sep = { type: 'separator', props: {} };
  children.push('sep');

  elements.view_btn = {
    type: 'button',
    props: { label: 'View in qbase', variant: 'secondary' },
    on: { press: { action: 'open_mini_app', params: { target: `${origin}/question/${query.id}?view=answers` } } },
  };
  children.push('view_btn');

  elements.page = { type: 'stack', props: { direction: 'vertical' }, children };

  return {
    version: '2.0',
    theme: { accent: 'purple' },
    ui: { root: 'page', elements },
  };
}

/**
 * Checkbox question — horizontal audience toggle + vertical checkbox toggle + submit.
 */
function checkboxQuestionToSnap(
  query: QueryRow,
  options: string[],
  origin: string,
): SnapResponse {
  const elements: Record<string, SnapElement> = {};
  const children: string[] = [];

  elements.stem = stemElement(query);
  children.push('stem');

  elements.stem_sep = { type: 'separator', props: {} };
  children.push('stem_sep');

  // Audience toggle (horizontal — visually distinct from vertical checkbox toggle)
  elements.audience = audienceToggleElement();
  children.push('audience');

  // Checkbox options (vertical toggle)
  elements.toggle = {
    type: 'toggle_group',
    props: {
      name: 'selections',
      options: options,
      multiple: true,
      orientation: 'vertical',
    },
  };
  children.push('toggle');

  const snapSubmitUrl = `${origin}/snap/question/${query.id}`;
  elements.submit_btn = {
    type: 'button',
    props: { label: 'Submit', variant: 'primary' },
    on: { press: { action: 'submit', params: { target: snapSubmitUrl } } },
  };

  elements.view_btn = viewInQbaseButton(query.id, origin);

  elements.btn_row = {
    type: 'stack',
    props: { direction: 'horizontal', gap: 'md', justify: 'start' },
    children: ['submit_btn', 'view_btn'],
  };
  children.push('btn_row');

  // Footer — answer count only
  const answerCount = query.pub_answers ?? 0;
  const answerLabel = answerCount === 1 ? 'answer' : 'answers';
  elements.footer = {
    type: 'text',
    props: { content: `${answerCount} ${answerLabel}`, size: 'sm' },
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
 * Checkbox results — per-option bar chart.
 */
export function checkboxResultsToSnap(
  query: QueryRow,
  selected: string[],
  optionCounts: Record<string, number>,
  origin: string,
): SnapResponse {
  const snapUrl = `${origin}/snap/question/${query.id}`;
  const options = parseOptions(query.a_options);

  const ordered = [...options];
  for (const k of Object.keys(optionCounts)) {
    if (!ordered.includes(k)) ordered.push(k);
  }

  const bars = ordered.map((label) => ({
    label: label.slice(0, 40),
    value: optionCounts[label] ?? 0,
  }));

  const totalAnswers = query.pub_answers ?? 0;
  const selectedText = selected.length > 0
    ? `You selected: ${selected.join(', ')}`
    : 'Selection recorded';

  const elements: Record<string, SnapElement> = {
    header: { type: 'text', props: { content: selectedText, weight: 'bold', size: 'md' } },
    chart: { type: 'bar_chart', props: { bars } },
    total: {
      type: 'text',
      props: { content: `${totalAnswers} ${totalAnswers === 1 ? 'answer' : 'answers'}`, size: 'sm' },
    },
  };

  const children: string[] = ['header', 'chart', 'total'];

  const attr = attributionElement(query);
  if (attr) {
    elements.attr = attr;
    children.push('attr');
  }

  elements.sep = { type: 'separator', props: {} };
  children.push('sep');

  elements.share_btn = {
    type: 'button',
    props: { label: 'Share', variant: 'primary' },
    on: {
      press: {
        action: 'compose_cast',
        params: { text: query.stem, embeds: [snapUrl] },
      },
    },
  };

  elements.view_btn = {
    type: 'button',
    props: { label: 'View in qbase', variant: 'secondary' },
    on: { press: { action: 'open_mini_app', params: { target: `${origin}/question/${query.id}?view=answers` } } },
  };

  elements.btn_row = {
    type: 'stack',
    props: { direction: 'horizontal', gap: 'md', justify: 'center' },
    children: ['share_btn', 'view_btn'],
  };
  children.push('btn_row');

  elements.page = { type: 'stack', props: { direction: 'vertical' }, children };

  return {
    version: '2.0',
    theme: { accent: 'purple' },
    ui: { root: 'page', elements },
  };
}

/**
 * Scene 2 — results view shown after answering (or when returning).
 *
 * Layout:
 *   "You answered [choice]" or "You already answered [choice]"
 *   bar chart (aggregate results)
 *   "asked by @user via @qbase"
 *   [Share question]  [View in qbase]
 */
export function questionResultsToSnap(
  query: QueryRow,
  counts: Record<string, number>,
  userChoice: string,
  origin: string,
  alreadyAnswered: boolean = false,
  /**
   * When set (poll locked), `userChoice` is ignored and this string is shown
   * instead of the "you answered X" line. Used for closed polls and
   * ineligible viewers — surfaces the reason while keeping the bar chart.
   */
  lockReason?: string,
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
  const answerText = lockReason
    ? lockReason
    : alreadyAnswered
      ? `You already answered ${userChoice}`
      : `You answered ${userChoice}`;

  const elements: Record<string, SnapElement> = {
    answer_line: {
      type: 'text',
      props: { content: answerText, weight: 'bold', size: 'md' },
    },
    chart: { type: 'bar_chart', props: { bars } },
    total: {
      type: 'text',
      props: { content: `${total} ${total === 1 ? 'answer' : 'answers'}`, size: 'sm' },
    },
  };

  const children: string[] = ['answer_line', 'chart', 'total'];

  const attr = attributionElement(query);
  if (attr) {
    elements.attr = attr;
    children.push('attr');
  }

  elements.sep = { type: 'separator', props: {} };
  children.push('sep');

  // [Share question] — compose a cast with the snap URL
  elements.share_btn = {
    type: 'button',
    props: { label: 'Share', variant: 'primary' },
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

  // [View in qbase] — open the question page as a Farcaster miniapp
  elements.view_btn = {
    type: 'button',
    props: { label: 'View in qbase', variant: 'secondary' },
    on: { press: { action: 'open_mini_app', params: { target: `${origin}/question/${query.id}?view=answers` } } },
  };

  elements.btn_row = {
    type: 'stack',
    props: { direction: 'horizontal', gap: 'md', justify: 'center' },
    children: ['share_btn', 'view_btn'],
  };
  children.push('btn_row');

  elements.page = { type: 'stack', props: { direction: 'vertical' }, children };

  return {
    version: '2.0',
    theme: { accent: 'purple' },
    ui: { root: 'page', elements },
  };
}

/**
 * Fallback snap for types that can't be answered inline (scale_range, checkbox >6 options, etc.)
 */
export function fallbackToMiniapp(query: QueryRow, origin: string): SnapResponse {
  const elements: Record<string, SnapElement> = {};
  const children: string[] = [];

  elements.stem = stemElement(query);
  children.push('stem');

  // Checkbox >6: just stem + button (no hint/separator)
  if (query.type !== 'checkbox') {
    elements.stem_sep = { type: 'separator', props: {} };
    children.push('stem_sep');

    let hint = 'Open on qbase to answer';
    if (query.type === 'scale_range') hint = 'Range questions need the full interface — answer on qbase';
    else if (query.type === 'text') hint = 'Open-ended — answer on qbase';

    elements.hint = { type: 'text', props: { content: hint, size: 'sm' } };
    children.push('hint');

    elements.sep = { type: 'separator', props: {} };
    children.push('sep');
  }

  elements.open_btn = {
    type: 'button',
    props: { label: 'Answer on qbase', variant: 'primary' },
    on: { press: { action: 'open_mini_app', params: { target: `${origin}/question/${query.id}` } } },
  };
  children.push('open_btn');

  const answerCount = query.pub_answers ?? 0;
  const label = answerCount === 1 ? 'answer' : 'answers';
  elements.footer = {
    type: 'text',
    props: { content: `${answerCount} ${label}`, size: 'sm' },
  };
  children.push('footer');

  elements.page = { type: 'stack', props: { direction: 'vertical' }, children };

  return {
    version: '2.0',
    theme: { accent: 'purple' },
    ui: { root: 'page', elements },
  };
}

// ─── Scale snap ──────────────────────────────────────────────────────────

/**
 * Scene 1 — scale question with slider + submit.
 */
export function scaleQuestionToSnap(
  query: QueryRow,
  config: ScaleConfig,
  origin: string,
): SnapResponse {
  const elements: Record<string, SnapElement> = {};
  const children: string[] = [];

  elements.stem = stemElement(query);
  children.push('stem');

  elements.stem_sep = { type: 'separator', props: {} };
  children.push('stem_sep');

  // Audience toggle (horizontal)
  elements.audience = audienceToggleElement();
  children.push('audience');

  // Build label from config endpoints if available
  // Check customLabels (from scale_config column), then labels (from a_options)
  const resolveLabel = (val: number): string => {
    const custom = config.customLabels?.find(c => c.value === val);
    if (custom) return custom.label;
    return config.labels?.[String(val)] ?? String(val);
  };
  elements.slider = {
    type: 'slider',
    props: {
      name: 'value',
      min: config.min,
      max: config.max,
      step: config.step,
      defaultValue: Math.round((config.min + config.max) / 2),
      label: `${resolveLabel(config.min)} to ${resolveLabel(config.max)}`,
      showValue: true,
    },
  };
  children.push('slider');

  const snapSubmitUrl = `${origin}/snap/question/${query.id}`;
  elements.submit_btn = {
    type: 'button',
    props: { label: 'Submit', variant: 'primary' },
    on: { press: { action: 'submit', params: { target: snapSubmitUrl } } },
  };

  elements.view_btn = viewInQbaseButton(query.id, origin);

  elements.btn_row = {
    type: 'stack',
    props: { direction: 'horizontal', gap: 'md', justify: 'start' },
    children: ['submit_btn', 'view_btn'],
  };
  children.push('btn_row');

  // Footer — answer count only
  const answerCount = query.pub_answers ?? 0;
  const answerLabel = answerCount === 1 ? 'answer' : 'answers';
  elements.footer = {
    type: 'text',
    props: { content: `${answerCount} ${answerLabel}`, size: 'sm' },
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
 * Build bucketed distribution bars for scale results.
 * For ≤6 values: one bar per value. For >6 values: group into ~5 buckets.
 */
function buildScaleDistributionBars(
  values: number[],
  config: ScaleConfig,
): { bars: Array<{ label: string; value: number }>; avg: number } {
  if (values.length === 0) return { bars: [], avg: 0 };

  const avg = values.reduce((s, v) => s + v, 0) / values.length;
  const range = config.max - config.min + 1;

  if (range <= 6) {
    // One bar per value
    const counts: Record<number, number> = {};
    for (let v = config.min; v <= config.max; v += config.step) counts[v] = 0;
    for (const v of values) counts[v] = (counts[v] ?? 0) + 1;
    const bars = Object.entries(counts).map(([val, count]) => ({
      label: config.labels?.[val] ?? val,
      value: count,
    }));
    return { bars, avg };
  }

  // Bucket into ~5 groups
  const bucketCount = Math.min(5, range);
  const bucketSize = Math.ceil(range / bucketCount);
  const buckets: Array<{ label: string; value: number }> = [];

  for (let i = 0; i < bucketCount; i++) {
    const lo = config.min + i * bucketSize;
    const hi = Math.min(lo + bucketSize - 1, config.max);
    const label = `${lo}-${hi}`;
    const count = values.filter((v) => v >= lo && v <= hi).length;
    buckets.push({ label, value: count });
  }

  return { bars: buckets, avg: Math.round(avg * 10) / 10 };
}

/**
 * Scene 2 — scale results with distribution bar chart.
 */
export function scaleResultsToSnap(
  query: QueryRow,
  userValue: number,
  values: number[],
  config: ScaleConfig,
  origin: string,
  alreadyAnswered: boolean = false,
): SnapResponse {
  const snapUrl = `${origin}/snap/question/${query.id}`;
  const { bars, avg } = buildScaleDistributionBars(values, config);

  const headerText = alreadyAnswered
    ? `You previously answered: ${userValue}`
    : `You answered: ${userValue}`;

  const elements: Record<string, SnapElement> = {
    header: { type: 'text', props: { content: headerText, weight: 'bold', size: 'md' } },
    chart: { type: 'bar_chart', props: { bars } },
    stats: {
      type: 'text',
      props: { content: `${values.length} ${values.length === 1 ? 'answer' : 'answers'} · avg ${avg}`, size: 'sm' },
    },
  };

  const children: string[] = ['header', 'chart', 'stats'];

  const attr = attributionElement(query);
  if (attr) {
    elements.attr = attr;
    children.push('attr');
  }

  elements.sep = { type: 'separator', props: {} };
  children.push('sep');

  elements.share_btn = {
    type: 'button',
    props: { label: 'Share', variant: 'primary' },
    on: {
      press: {
        action: 'compose_cast',
        params: { text: query.stem, embeds: [snapUrl] },
      },
    },
  };

  elements.view_btn = {
    type: 'button',
    props: { label: 'View in qbase', variant: 'secondary' },
    on: { press: { action: 'open_mini_app', params: { target: `${origin}/question/${query.id}?view=answers` } } },
  };

  elements.btn_row = {
    type: 'stack',
    props: { direction: 'horizontal', gap: 'md', justify: 'center' },
    children: ['share_btn', 'view_btn'],
  };
  children.push('btn_row');

  elements.page = { type: 'stack', props: { direction: 'vertical' }, children };

  return {
    version: '2.0',
    theme: { accent: 'purple' },
    ui: { root: 'page', elements },
  };
}

// ─── Dedup confirmation scene ────────────────────────────────────────────

/**
 * Shown when a user has already answered a question (non-mc types).
 * Append-only model: lets them submit a new answer row or keep the old one.
 */
export function dedupConfirmationSnap(
  query: QueryRow,
  latestValue: string,
  origin: string,
): SnapResponse {
  const snapUrl = `${origin}/snap/question/${query.id}`;
  const elements: Record<string, SnapElement> = {};
  const children: string[] = [];

  elements.header = {
    type: 'text',
    props: { content: '⚠ You already answered this', weight: 'bold', size: 'md' },
  };
  children.push('header');

  // Truncate display value if too long
  const displayValue = latestValue.length > 80 ? latestValue.slice(0, 77) + '...' : latestValue;
  elements.prev = {
    type: 'text',
    props: { content: `Your latest answer: "${displayValue}"`, size: 'sm' },
  };
  children.push('prev');

  elements.sep = { type: 'separator', props: {} };
  children.push('sep');

  // "Submit new answer" re-submits (append-only, new row)
  elements.submit_new = {
    type: 'button',
    props: { label: 'Submit new answer', variant: 'primary' },
    on: { press: { action: 'submit', params: { target: `${snapUrl}?confirm_new=1` } } },
  };
  children.push('submit_new');

  // "Keep my old answer" shows results
  elements.keep_btn = {
    type: 'button',
    props: { label: 'Keep my old answer', variant: 'secondary' },
    on: { press: { action: 'submit', params: { target: `${snapUrl}?keep_old=1` } } },
  };
  children.push('keep_btn');

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
          options: q.options,
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
