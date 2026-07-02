/**
 * AggregateResultsService — public distribution data for the aggregate
 * result pages (/question/:id/results) and their OG chart images.
 *
 * Counting semantics intentionally mirror AnswerCountService (latest answer
 * per user via ROW_NUMBER CTE) so the web page, the snap result scenes, and
 * the OG chart all report the same numbers for the same question.
 */

import { getMcCounts, getCheckboxCounts } from './AnswerCountService';
import { parseOptions, parseScaleConfig } from './SnapService';
import { parseOptionsConfig, listVisibleOptions } from './PollOptionsService';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type D1Database = any;

export interface DistributionRow {
  label: string;
  count: number;
  /** Percent of unique responders (0-100, rounded). Checkbox rows can sum >100. */
  pct: number;
}

export interface RecentAnswer {
  value: string;
  author: string; // fname, or 'anon' for Anon-audience rows
  created_at: string | null;
}

export interface AggregateResults {
  question: {
    id: string;
    stem: string;
    type: string;
    options: string[];
    created_at: string | null;
    coiner_fname: string | null;
    coiner_fid: number | null;
  };
  /** Unique responders (latest answer per user). */
  total: number;
  /** Per-option rows for mc / checkbox / scale. Empty for text. */
  distribution: DistributionRow[];
  /** Latest public/anon answers — populated for text questions only. */
  recent: RecentAnswer[];
}

interface QueryRow {
  id: string;
  stem: string;
  type: string;
  a_options: string | null;
  options_config: string | null;
  scale_config: string | null;
  created_at: string | null;
  coiner_fname: string | null;
  coiner_fid: number | null;
}

const RECENT_TEXT_LIMIT = 12;

/**
 * Order MC/checkbox counts by the question's declared option order, then any
 * stray labels (legacy/free values) by count descending. Zero-count declared
 * options are kept so the chart shows the full option set.
 */
export function shapeOptionDistribution(
  options: string[],
  counts: Record<string, number>,
  total: number,
): DistributionRow[] {
  const pct = (count: number) => (total > 0 ? Math.round((count / total) * 100) : 0);
  const rows: DistributionRow[] = options.map((label) => ({
    label,
    count: counts[label] ?? 0,
    pct: pct(counts[label] ?? 0),
  }));
  const declared = new Set(options);
  const strays = Object.entries(counts)
    .filter(([label]) => !declared.has(label))
    .sort((a, b) => b[1] - a[1])
    .map(([label, count]) => ({ label, count, pct: pct(count) }));
  return [...rows, ...strays];
}

/**
 * Label a raw scale value using the question's scale config: custom label if
 * one is declared for the value, else endpoint label, else the bare numeric.
 */
export function labelScaleValue(
  value: number,
  config: { labels?: Record<string, string>; customLabels?: { value: number; label: string }[] } | null,
): string {
  const custom = config?.customLabels?.find((c) => c.value === value);
  if (custom) return `${value} · ${custom.label}`;
  const endpoint = config?.labels?.[String(value)];
  if (endpoint) return `${value} · ${endpoint}`;
  return String(value);
}

async function getScaleDistribution(
  db: D1Database,
  questionId: string,
  scaleConfigRaw: { a_options: string | null; scale_config: string | null },
): Promise<{ rows: DistributionRow[]; total: number }> {
  // Same latest-per-user CTE + audience filter as AnswerCountService.getScaleCounts,
  // extended with a per-value breakdown (scale values are discrete in practice).
  const { results } = await db.prepare(`
    WITH latest_per_user AS (
      SELECT user_id, value,
        ROW_NUMBER() OVER (
          PARTITION BY user_id ORDER BY created_at DESC, id DESC
        ) as rn
      FROM Answers
      WHERE q_id = ? AND answer_type_id = 3 AND audience = 'Public'
    )
    SELECT value, COUNT(*) as count
    FROM latest_per_user WHERE rn = 1
    GROUP BY value
  `).bind(questionId).all();

  const config = parseScaleConfig(scaleConfigRaw.a_options) ?? parseScaleConfig(scaleConfigRaw.scale_config);
  const counted = ((results || []) as Array<{ value: string; count: number }>)
    .map((r) => ({ numeric: Number(r.value), count: r.count }))
    .filter((r) => Number.isFinite(r.numeric))
    .sort((a, b) => a.numeric - b.numeric);
  const total = counted.reduce((sum, r) => sum + r.count, 0);
  const rows = counted.map((r) => ({
    label: labelScaleValue(r.numeric, config),
    count: r.count,
    pct: total > 0 ? Math.round((r.count / total) * 100) : 0,
  }));
  return { rows, total };
}

async function getTextAggregate(
  db: D1Database,
  questionId: string,
): Promise<{ total: number; recent: RecentAnswer[] }> {
  const totalRow = await db.prepare(`
    SELECT COUNT(DISTINCT user_id) as total FROM Answers
    WHERE q_id = ? AND answer_type_id = 1 AND audience IN ('Public', 'Anon')
  `).bind(questionId).first() as { total: number } | null;

  const { results } = await db.prepare(`
    SELECT a.value, a.audience, a.created_at, u.fname
    FROM Answers a
    LEFT JOIN Users u ON u.fid = a.user_id
    WHERE a.q_id = ? AND a.answer_type_id = 1 AND a.audience IN ('Public', 'Anon')
    ORDER BY a.created_at DESC
    LIMIT ?
  `).bind(questionId, RECENT_TEXT_LIMIT).all();

  const recent = ((results || []) as Array<{
    value: string; audience: string; created_at: string | null; fname: string | null;
  }>).map((r) => ({
    value: r.value,
    author: r.audience === 'Anon' ? 'anon' : (r.fname || 'anon'),
    created_at: r.created_at,
  }));

  return { total: totalRow?.total ?? 0, recent };
}

/**
 * Build the aggregate results payload for a question, or null if the
 * question doesn't exist. Only Public/Anon answers are ever counted —
 * Secret/Allowlist stay out of aggregates by construction.
 */
export async function getAggregateResults(
  db: D1Database,
  questionId: string,
): Promise<AggregateResults | null> {
  const query = await db.prepare(`
    SELECT id, stem, type, a_options, options_config, scale_config, created_at, coiner_fname, coiner_fid
    FROM queries WHERE id = ?
  `).bind(questionId).first() as QueryRow | null;
  if (!query) return null;

  // Open-options polls: the live (visible) option set defines the declared
  // order so write-ins aren't treated as trailing "stray" labels.
  const openCfg = query.type === 'mc' ? parseOptionsConfig(query.options_config) : null;
  const options = query.type === 'scale'
    ? []
    : openCfg
      ? (await listVisibleOptions(db, questionId)).map((o) => o.label)
      : parseOptions(query.a_options);
  const base: AggregateResults = {
    question: {
      id: query.id,
      stem: query.stem,
      type: query.type,
      options,
      created_at: query.created_at,
      coiner_fname: query.coiner_fname,
      coiner_fid: query.coiner_fid,
    },
    total: 0,
    distribution: [],
    recent: [],
  };

  if (query.type === 'mc') {
    const { counts, total } = await getMcCounts(db, questionId);
    base.total = total;
    base.distribution = shapeOptionDistribution(options, counts, total);
  } else if (query.type === 'checkbox') {
    const { optionCounts, total } = await getCheckboxCounts(db, questionId);
    base.total = total;
    base.distribution = shapeOptionDistribution(options, optionCounts, total);
  } else if (query.type === 'scale') {
    const { rows, total } = await getScaleDistribution(db, questionId, query);
    base.total = total;
    base.distribution = rows;
  } else {
    // text / date / anything else: responder count + recent text answers
    const { total, recent } = await getTextAggregate(db, questionId);
    base.total = total;
    base.recent = recent;
  }

  return base;
}
