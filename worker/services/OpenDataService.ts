/**
 * OpenDataService — the open release of qbase's aggregates (DATA.md;
 * docs/strategy/2026-10-11-product-question.md §4, §7.2–7.3).
 *
 * The live result pages are public; this is the *open* form of the same
 * tallies: licensed (CC BY 4.0), floored, and stamped with provenance, one
 * canonical item at a time plus an index for bulk use.
 *
 * Rules, all in this file so a reader can check them in one place:
 *   - Counted: each person's latest Public or Anon answer per scope (the
 *     question, or one wave of it), the same counting as the live pages.
 *     Secret, Allowlist and Vault never enter (consent-model.md §3: Secret
 *     contribution waits on the switches and ConsentService).
 *   - Floor (OPEN_FLOOR = 10, docs/DECISIONS.md 2026-10-11): a scope with fewer
 *     than 10 people publishes its n and nothing else; any cell from 1 to 9
 *     is withheld, and where cells sum to n (mc, scale, the tier split) a
 *     lone withheld cell takes the next-smallest with it so it can't be
 *     recovered by subtraction.
 *   - Items: mc / checkbox / scale questions with at least 10 people, not a
 *     help request (taxonomy intent = request) and not safety-flagged. Text
 *     answers are individual content, not aggregates, and are never released.
 *   - Labels: declared options only (an open-options wave: its visible
 *     write-ins). Votes for any other label (legacy free values, moderated
 *     write-ins) count in `other`, so a hidden label is never republished.
 *   - Withdrawal is forward-only (consent-model.md decision 16): a release is
 *     computed from current rows and dated by `generated_at`; a withdrawn or
 *     re-scoped answer leaves every release after it, and earlier releases
 *     stand.
 */

import { personKeySql } from './anon/AnonTag';
import { parseOptions, parseScaleConfig } from './SnapService';
import { declaredOptions, labelScaleValue } from './AggregateResultsService';
import { isPollClosed, listPollsForQuestion, parsePollGate, type PollRow } from './PollService';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type D1Database = any;

export const OPEN_FLOOR = 10;
export const OPEN_SCHEMA = 'qbase-open-item/1';
export const OPEN_LICENSE = {
  id: 'CC-BY-4.0',
  url: 'https://creativecommons.org/licenses/by/4.0/',
  attribution: 'qbase (https://qbase.tech), from answers its respondents chose to make public or anonymous',
} as const;

type ReleasableType = 'mc' | 'checkbox' | 'scale';
const ANSWER_TYPE_ID: Record<ReleasableType, number> = { mc: 2, scale: 3, checkbox: 4 };
const OTHER_LABEL = 'other';

/** SQL predicate for a question eligible for release (alias `q`). */
const RELEASABLE_QUESTION_SQL =
  `q.type IN ('mc', 'checkbox', 'scale')` +
  ` AND COALESCE(json_extract(q.taxonomy, '$.intent'), '') <> 'request'` +
  ` AND COALESCE(json_extract(q.taxonomy, '$.safety_flag'), 0) <> 1`;

export interface OpenCell {
  label: string;
  /** null = withheld under the floor. */
  count: number | null;
  /** Percent of the scope's n (0-100, rounded); null when withheld. Checkbox rows can sum >100. */
  pct: number | null;
}

export interface OpenScope {
  /** People counted (latest answer each). */
  n: number;
  /** n is under the floor: nothing but n is published for this scope. */
  below_floor: boolean;
  /** How the counted answers were given; null when below the floor. */
  tiers: { public: number | null; anon: number | null } | null;
  distribution: OpenCell[];
}

export interface OpenWave extends OpenScope {
  id: string;
  kind: string;
  opened_at: string;
  closes_at: string;
  is_closed: boolean;
  /** Eligibility gate type (world_id, nft_snapshot, …), or null for an open wave. */
  gate: string | null;
  /** World ID wave: every counted answer carried a proof of a unique human. */
  verified_humans: boolean;
}

export interface OpenItem {
  schema: typeof OPEN_SCHEMA;
  license: typeof OPEN_LICENSE;
  generated_at: string;
  floor: number;
  method: {
    counting: string;
    tiers_counted: string[];
    sample: string;
    withdrawal: string;
  };
  question: {
    id: string;
    url: string;
    stem: string;
    type: ReleasableType;
    options: string[];
    /** Scale questions: the declared scale config as stored. */
    scale: unknown;
    created_at: string | null;
    /** sha256 of the wording (stem, type, options, scale config); changes if any of them does. */
    wording_sha256: string;
  };
  /** Every answer on the question, direct and through any wave. */
  overall: OpenScope;
  /** One entry per wave, oldest first. */
  waves: OpenWave[];
}

const METHOD: OpenItem['method'] = {
  counting: 'each person\'s latest answer per scope (the question, or one wave of it)',
  tiers_counted: ['Public', 'Anon'],
  sample: 'self-selected respondents; unweighted; not representative of any population',
  withdrawal: 'forward-only: a withdrawn or re-scoped answer leaves releases generated after it; earlier releases stand',
};

interface QueryRow {
  id: string;
  stem: string;
  type: string;
  a_options: string | null;
  scale_config: string | null;
  created_at: string | null;
}

interface LatestRow {
  value: string;
  audience: string;
}

/**
 * Withhold cells from 1 to floor-1. With `complementary` (cells sum to the
 * scope's n), a single withheld cell also withholds the smallest remaining
 * non-zero cell, so the withheld one can't be recovered as n minus the rest.
 * Zero cells are published: they disclose nobody.
 */
export function floorCounts(counts: number[], floor: number, complementary: boolean): (number | null)[] {
  const out: (number | null)[] = counts.map((c) => (c > 0 && c < floor ? null : c));
  if (complementary && out.filter((c) => c === null).length === 1) {
    let pick = -1;
    out.forEach((c, i) => {
      if (c !== null && c > 0 && (pick < 0 || c < (out[pick] as number))) pick = i;
    });
    if (pick >= 0) out[pick] = null;
  }
  return out;
}

/** Shape one scope's latest rows into a floored OpenScope. */
export function buildScope(
  rows: LatestRow[],
  type: ReleasableType,
  labels: string[],
  labelOf: (value: string) => string[],
  floor: number = OPEN_FLOOR,
): OpenScope {
  const n = rows.length;
  if (n < floor) return { n, below_floor: true, tiers: null, distribution: [] };

  const counts = new Map<string, number>(labels.map((l) => [l, 0]));
  let other = 0;
  let anon = 0;
  for (const row of rows) {
    if (row.audience === 'Anon') anon++;
    for (const label of labelOf(row.value)) {
      if (counts.has(label)) counts.set(label, (counts.get(label) ?? 0) + 1);
      else other++;
    }
  }

  const cells = [...counts.entries()].map(([label, count]) => ({ label, count }));
  if (other > 0) cells.push({ label: OTHER_LABEL, count: other });
  const floored = floorCounts(cells.map((c) => c.count), floor, type !== 'checkbox');
  const distribution = cells.map((c, i) => {
    const count = floored[i];
    return { label: c.label, count, pct: count === null ? null : Math.round((count / n) * 100) };
  });

  const [pub, an] = floorCounts([n - anon, anon], floor, true);
  return { n, below_floor: false, tiers: { public: pub, anon: an }, distribution };
}

async function latestRows(
  db: D1Database,
  questionId: string,
  type: ReleasableType,
  pollId: string | null,
): Promise<LatestRow[]> {
  const scopeSql = pollId ? ' AND a.poll_id = ?' : '';
  const binds = pollId ? [questionId, pollId] : [questionId];
  const { results } = await db.prepare(`
    WITH latest_per_person AS (
      SELECT a.value, a.audience,
        ROW_NUMBER() OVER (
          PARTITION BY ${personKeySql('a')} ORDER BY a.created_at DESC, a.id DESC
        ) as rn
      FROM Answers a
      WHERE a.q_id = ? AND a.answer_type_id = ${ANSWER_TYPE_ID[type]} AND a.audience IN ('Public', 'Anon')${scopeSql}
    )
    SELECT value, audience FROM latest_per_person WHERE rn = 1
  `).bind(...binds).all();
  return (results || []) as LatestRow[];
}

/** Labels and the value → label(s) mapping for one scope. */
async function scopeLabels(
  db: D1Database,
  query: QueryRow,
  type: ReleasableType,
  poll: PollRow | null,
  scaleValues: string[],
): Promise<{ labels: string[]; labelOf: (value: string) => string[] }> {
  if (type === 'scale') {
    const config = parseScaleConfig(query.a_options) ?? parseScaleConfig(query.scale_config);
    const label = (v: string) => (Number.isFinite(Number(v)) ? labelScaleValue(Number(v), config) : v);
    const labels = [...new Set(scaleValues.filter((v) => Number.isFinite(Number(v))))]
      .sort((a, b) => Number(a) - Number(b))
      .map(label);
    return { labels, labelOf: (v) => [label(v)] };
  }
  const labels = await declaredOptions(db, query, poll);
  if (type === 'checkbox') {
    return { labels, labelOf: (v) => v.split(',').map((s) => s.trim()).filter(Boolean) };
  }
  return { labels, labelOf: (v) => [v] };
}

async function scopeFor(
  db: D1Database,
  query: QueryRow,
  type: ReleasableType,
  poll: PollRow | null,
): Promise<OpenScope> {
  const rows = await latestRows(db, query.id, type, poll?.id ?? null);
  // Scale labels come from the values present; only published once n clears the floor.
  const { labels, labelOf } = await scopeLabels(db, query, type, poll, rows.map((r) => r.value));
  return buildScope(rows, type, labels, labelOf);
}

export async function wordingHash(query: Pick<QueryRow, 'stem' | 'type' | 'a_options' | 'scale_config'>): Promise<string> {
  const text = [query.stem, query.type, query.a_options ?? '', query.scale_config ?? ''].join('\n');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The open release of one question, or null when the question doesn't exist
 * or isn't releasable (wrong type, a help request, safety-flagged, or fewer
 * than OPEN_FLOOR people overall).
 */
export async function getOpenItem(db: D1Database, questionId: string, origin: string): Promise<OpenItem | null> {
  const query = await db.prepare(`
    SELECT q.id, q.stem, q.type, q.a_options, q.scale_config, q.created_at
    FROM queries q WHERE q.id = ? AND ${RELEASABLE_QUESTION_SQL}
  `).bind(questionId).first() as QueryRow | null;
  if (!query) return null;
  const type = query.type as ReleasableType;

  const overall = await scopeFor(db, query, type, null);
  if (overall.below_floor) return null;

  const polls = (await listPollsForQuestion(db, query.id))
    .slice()
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const waves: OpenWave[] = [];
  for (const poll of polls) {
    const gate = parsePollGate(poll.eligibility_gate);
    waves.push({
      id: poll.id,
      kind: poll.kind ?? 'measure',
      opened_at: poll.created_at,
      closes_at: poll.closes_at,
      is_closed: isPollClosed(poll),
      gate: gate?.type ?? null,
      verified_humans: gate?.type === 'world_id',
      ...(await scopeFor(db, query, type, poll)),
    });
  }

  return {
    schema: OPEN_SCHEMA,
    license: OPEN_LICENSE,
    generated_at: new Date().toISOString(),
    floor: OPEN_FLOOR,
    method: METHOD,
    question: {
      id: query.id,
      url: `${origin}/question/${query.id}/results`,
      stem: query.stem,
      type,
      options: type === 'scale' ? [] : parseOptions(query.a_options),
      scale: type === 'scale' ? (parseScaleConfig(query.a_options) ?? parseScaleConfig(query.scale_config)) : null,
      created_at: query.created_at,
      wording_sha256: await wordingHash(query),
    },
    overall,
    waves,
  };
}

export interface OpenIndexEntry {
  id: string;
  stem: string;
  type: string;
  n: number;
  last_answer_at: string | null;
  /** The item's release (JSON); swap the extension for `.csv`. */
  url: string;
}

/**
 * Every releasable question, by id, keyset-paginated. `n` here is the
 * overall people count; the item endpoint applies the floor per scope.
 */
export async function listOpenItems(
  db: D1Database,
  origin: string,
  opts: { after?: string | null; limit?: number } = {},
): Promise<{ items: OpenIndexEntry[]; next: string | null }> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const { results } = await db.prepare(`
    WITH counted AS (
      SELECT a.q_id, COUNT(DISTINCT ${personKeySql('a')}) AS n, MAX(a.created_at) AS last_answer_at
      FROM Answers a
      JOIN queries q ON q.id = a.q_id
      WHERE a.audience IN ('Public', 'Anon')
        AND a.answer_type_id = CASE q.type WHEN 'mc' THEN 2 WHEN 'scale' THEN 3 WHEN 'checkbox' THEN 4 END
        AND ${RELEASABLE_QUESTION_SQL}
        AND a.q_id > ?
      GROUP BY a.q_id
      HAVING n >= ${OPEN_FLOOR}
    )
    SELECT q.id, q.stem, q.type, c.n, c.last_answer_at
    FROM counted c JOIN queries q ON q.id = c.q_id
    ORDER BY q.id
    LIMIT ?
  `).bind(opts.after ?? '', limit + 1).all();

  const rows = (results || []) as Array<{ id: string; stem: string; type: string; n: number; last_answer_at: string | null }>;
  const page = rows.slice(0, limit);
  return {
    items: page.map((r) => ({ ...r, url: `${origin}/api/open/items/${r.id}.json` })),
    next: rows.length > limit ? page[page.length - 1].id : null,
  };
}

function csvField(value: string | number | null): string {
  if (value === null) return '';
  const s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Long-format CSV of one item: one row per (scope, label). A withheld cell
 * has an empty count and pct; a scope under the floor has one row with its n
 * and an empty label.
 */
export function openItemCsv(item: OpenItem): string {
  const header = ['question_id', 'scope', 'wave_id', 'wave_closed', 'verified_humans', 'n', 'label', 'count', 'pct'];
  const lines = [header.join(',')];
  const emit = (s: OpenScope, scopeName: string, wave: OpenWave | null) => {
    const prefix = [item.question.id, scopeName, wave?.id ?? null, wave ? String(wave.is_closed) : null, wave ? String(wave.verified_humans) : null, s.n];
    if (s.below_floor) {
      lines.push([...prefix, null, null, null].map(csvField).join(','));
      return;
    }
    for (const cell of s.distribution) {
      lines.push([...prefix, cell.label, cell.count, cell.pct].map(csvField).join(','));
    }
  };
  emit(item.overall, 'overall', null);
  for (const wave of item.waves) emit(wave, 'wave', wave);
  return lines.join('\n') + '\n';
}
