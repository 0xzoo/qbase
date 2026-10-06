/**
 * AggregateResultsService — public distribution data for the aggregate
 * result pages (/question/:id/results, /poll/:id/results) and their OG
 * chart images.
 *
 * Counting semantics intentionally mirror AnswerCountService (latest answer
 * per user via ROW_NUMBER CTE) so the web page, the snap result scenes, and
 * the OG chart all report the same numbers for the same question.
 *
 * Two surfaces over one question:
 *   - question-level: every answer, latest per user (direct + all waves)
 *   - wave-level:     `Answers WHERE poll_id = P`, latest per (wave, user),
 *                     plus the vote-change signal (churn / change log)
 */

import { getMcCounts, getCheckboxCounts, getVoteChurn, type VoteChurn, type VoteChange } from './AnswerCountService';
import { personKeySql } from './anon/AnonTag';
import { parseOptions, parseScaleConfig } from './SnapService';
import { parseOptionsConfig, listVisibleOptions } from './PollOptionsService';
import { getPoll, isPollClosed, parsePollGate, type PollRow } from './PollService';
import { anon_id, anon_fid } from '../../src/lib/consts';

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
    /** `request` = a Q&A thread, not a tally (taxonomy.intent); null for v1 rows. */
    intent: 'measure' | 'request' | null;
  };
  /** Unique responders (latest answer per user). */
  total: number;
  /** Per-option rows for mc / checkbox / scale. Empty for text. */
  distribution: DistributionRow[];
  /** Latest public/anon answers — populated for text questions only. */
  recent: RecentAnswer[];
  /** Present on the wave-level surface only. */
  poll?: {
    id: string;
    closes_at: string;
    is_closed: boolean;
    kind: string;
    created_at: string;
    /** World ID wave: each tallied answer is one verified unique human. */
    verified_humans?: boolean;
  };
  /** Vote-change signal (wave-level only). */
  churn?: VoteChurn;
  /** Public vote changes, newest first, capped (wave-level only). */
  changes?: VoteChange[];
}

interface QueryRow {
  id: string;
  stem: string;
  type: string;
  a_options: string | null;
  scale_config: string | null;
  created_at: string | null;
  coiner_fname: string | null;
  coiner_fid: number | null;
  intent: string | null;
}

const RECENT_TEXT_LIMIT = 12;

const ANSWER_TYPE_ID: Record<string, number> = { text: 1, mc: 2, scale: 3, checkbox: 4 };

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
  pollId?: string | null,
): Promise<{ rows: DistributionRow[]; total: number }> {
  // Same latest-per-person CTE + audience filter as AnswerCountService: the
  // partition is the person key, not user_id, because every Anon row carries
  // the @4n0n placeholder as user_id and would otherwise collapse into one vote.
  const scopeSql = pollId ? ' AND a.poll_id = ?' : '';
  const binds = pollId ? [questionId, pollId] : [questionId];
  const { results } = await db.prepare(`
    WITH latest_per_user AS (
      SELECT a.value,
        ROW_NUMBER() OVER (
          PARTITION BY ${personKeySql('a')} ORDER BY a.created_at DESC, a.id DESC
        ) as rn
      FROM Answers a
      WHERE a.q_id = ? AND a.answer_type_id = 3 AND a.audience IN ('Public', 'Anon')${scopeSql}
    )
    SELECT value, COUNT(*) as count
    FROM latest_per_user WHERE rn = 1
    GROUP BY value
  `).bind(...binds).all();

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
  pollId?: string | null,
): Promise<{ total: number; recent: RecentAnswer[] }> {
  const scopeSql = pollId ? ' AND poll_id = ?' : '';
  const scopeBinds = pollId ? [pollId] : [];
  const totalRow = await db.prepare(`
    SELECT COUNT(DISTINCT ${personKeySql('a')}) as total FROM Answers a
    WHERE a.q_id = ? AND a.answer_type_id = 1 AND a.audience IN ('Public', 'Anon')${scopeSql.replace('poll_id', 'a.poll_id')}
  `).bind(questionId, ...scopeBinds).first() as { total: number } | null;

  const { results } = await db.prepare(`
    SELECT a.value, a.audience, a.created_at, u.fname
    FROM Answers a
    LEFT JOIN Users u ON u.fid = a.user_id
    WHERE a.q_id = ? AND a.answer_type_id = 1 AND a.audience IN ('Public', 'Anon')${scopeSql.replace('poll_id', 'a.poll_id')}
    ORDER BY a.created_at DESC
    LIMIT ?
  `).bind(questionId, ...scopeBinds, RECENT_TEXT_LIMIT).all();

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
 * Declared option order for a question's distribution. Open-options waves
 * use the live (visible) option set so write-ins aren't treated as trailing
 * "stray" labels; everything else uses a_options.
 */
async function declaredOptions(db: D1Database, query: QueryRow, poll: PollRow | null): Promise<string[]> {
  if (query.type === 'scale') return [];
  const openCfg = poll && query.type === 'mc' ? parseOptionsConfig(poll.options_config) : null;
  if (openCfg && poll) {
    return (await listVisibleOptions(db, poll.id)).map((o) => o.label);
  }
  return parseOptions(query.a_options);
}

/**
 * Build the aggregate results payload for a question, or null if the
 * question doesn't exist. Only Public/Anon answers are ever counted —
 * Secret/Allowlist stay out of aggregates by construction. With `poll`,
 * the tally is scoped to that wave and carries the vote-change signal.
 */
export async function getAggregateResults(
  db: D1Database,
  questionId: string,
  poll: PollRow | null = null,
): Promise<AggregateResults | null> {
  const query = await db.prepare(`
    SELECT id, stem, type, a_options, scale_config, created_at, coiner_fname, coiner_fid,
           json_extract(taxonomy, '$.intent') AS intent
    FROM queries WHERE id = ?
  `).bind(questionId).first() as QueryRow | null;
  if (!query) return null;
  if (poll && poll.question_id !== query.id) return null;

  const pollId = poll?.id ?? null;
  const options = await declaredOptions(db, query, poll);
  const base: AggregateResults = {
    question: {
      id: query.id,
      stem: query.stem,
      type: query.type,
      options,
      created_at: query.created_at,
      coiner_fname: query.coiner_fname,
      coiner_fid: query.coiner_fid,
      intent: query.intent === 'request' || query.intent === 'measure' ? query.intent : null,
    },
    total: 0,
    distribution: [],
    recent: [],
  };

  if (query.type === 'mc') {
    const { counts, total } = await getMcCounts(db, questionId, pollId);
    base.total = total;
    base.distribution = shapeOptionDistribution(options, counts, total);
  } else if (query.type === 'checkbox') {
    const { optionCounts, total } = await getCheckboxCounts(db, questionId, pollId);
    base.total = total;
    base.distribution = shapeOptionDistribution(options, optionCounts, total);
  } else if (query.type === 'scale') {
    const { rows, total } = await getScaleDistribution(db, questionId, query, pollId);
    base.total = total;
    base.distribution = rows;
  } else {
    // text / date / anything else: responder count + recent text answers
    const { total, recent } = await getTextAggregate(db, questionId, pollId);
    base.total = total;
    base.recent = recent;
  }

  if (poll) {
    base.poll = {
      id: poll.id,
      closes_at: poll.closes_at,
      is_closed: isPollClosed(poll),
      kind: poll.kind ?? 'measure',
      created_at: poll.created_at,
      // Every tallied answer on a world_id wave carried a proof of a unique human.
      ...(parsePollGate(poll.eligibility_gate)?.type === 'world_id' ? { verified_humans: true } : {}),
    };
    const typeId = ANSWER_TYPE_ID[query.type];
    if (typeId && typeId !== 1) {
      const { churn, changes } = await getVoteChurn(db, poll.id, typeId, [anon_id, anon_fid]);
      base.churn = churn;
      base.changes = changes;
    } else {
      base.churn = { changed_voters: 0, total_changes: 0 };
      base.changes = [];
    }
  }

  return base;
}

/** Wave-level aggregate by poll id, or null when the wave doesn't exist. */
export async function getPollAggregateResults(
  db: D1Database,
  pollId: string,
): Promise<AggregateResults | null> {
  const poll = await getPoll(db, pollId);
  if (!poll) return null;
  return getAggregateResults(db, poll.question_id, poll);
}
