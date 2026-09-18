/**
 * QuizStatsService — the correlation report (docs/quizzes/CONTENT-PLAN.md
 * §7.9; card t_589c4f56): "people who answered like you on X were N× more
 * likely to answer Y". A read over every completion, not a quiz.
 *
 * Build (`buildQuizStats` → `buildStats`): one bucketed answer vector per
 * person — the latest non-anon completion per quiz, opened through
 * `readCompletionAnswers` (Secret = you + q; q counts, nobody sees a row) —
 * then for every ordered pair of items (X, Y), within a quiz or across
 * quizzes, and every bucket x of X: the share of people with X = x who
 * answered Y = y, against the base rate of Y = y among people who answered
 * both. A cell becomes a finding only when it clears the support and the
 * suppression floor (`minGroup` people with X = x, at least `minCell` of them
 * on each side of Y = y — never "all" or "none" of a group) and its lift is
 * outside [1/minLift, minLift]. Likert 1–5 collapses to disagree / neutral /
 * agree so cells have support; text items are not counted.
 *
 * The payload is aggregate counts only and is cached in `quiz_stats`
 * (migration 0071): rebuilt by the 8-hourly cron (`0 0/8 * * *` in
 * wrangler.jsonc), by POST /api/admin/quiz-stats/rebuild, or lazily when older
 * than a day.
 * `personalReport` intersects a person's own vector with the findings.
 */

import { readCompletionAnswers, type CompletionRow } from '../../routes/quiz-completions';
import { canonicalize, isMaterializedQuiz } from './canonicalAnswers';
import { itemMeta, QUIZ_TITLES } from './itemMeta';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Env = any;

export const STATS_KEY = 'correlations:v1';
export const STATS_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** `${quiz}:${q_id}` → bucket */
export type AnswerVector = Record<string, string>;

export interface StatsOptions {
  /** people with X = x needed before the group is looked at */
  minGroup: number;
  /** people on each side of Y = y within that group */
  minCell: number;
  /** lift at or beyond which (either direction) a cell is a finding */
  minLift: number;
}

export const DEFAULT_STATS_OPTIONS: StatsOptions = { minGroup: 10, minCell: 5, minLift: 1.5 };

export interface Finding {
  x: { key: string; bucket: string };
  y: { key: string; bucket: string };
  /** people who answered both X and Y */
  n: number;
  /** of those, people with X = x */
  n_x: number;
  /** of those, people with Y = y */
  n_xy: number;
  /** base rate of Y = y among the n */
  p_y: number;
  p_y_given_x: number;
  lift: number;
}

export interface QuizStatsPayload {
  version: 1;
  built_at: string;
  options: StatsOptions;
  users: number;
  users_per_quiz: Record<string, number>;
  items: Record<string, { n: number; buckets: Record<string, number> }>;
  findings: Finding[];
}

export const SCALE_BUCKETS = ['disagree', 'neutral', 'agree'] as const;

/** Likert 1–5 → three buckets; mc → the label; text → null (not counted). */
export function bucketOf(quiz: string, answer: unknown): { key: string; bucket: string } | null {
  const o = canonicalize(quiz, answer);
  if (!o.answer) return null;
  const a = o.answer;
  const key = `${quiz}:${a.qId}`;
  if (a.answerTypeId === 3) {
    const n = Number(a.value);
    if (!Number.isFinite(n)) return null;
    return { key, bucket: n <= 2 ? 'disagree' : n === 3 ? 'neutral' : 'agree' };
  }
  if (a.answerTypeId === 2) return { key, bucket: a.value };
  return null;
}

export function vectorOf(quiz: string, answers: unknown[]): AnswerVector {
  const v: AnswerVector = {};
  for (const a of answers) {
    const b = bucketOf(quiz, a);
    if (b) v[b.key] = b.bucket; // a repeated item keeps the later answer
  }
  return v;
}

/** Pure: findings over a set of per-person vectors. */
export function buildStats(vectors: AnswerVector[], options: StatsOptions = DEFAULT_STATS_OPTIONS, builtAt = new Date().toISOString()): QuizStatsPayload {
  const items: Record<string, { n: number; buckets: Record<string, number> }> = {};
  const usersPerQuiz: Record<string, Set<number>> = {};
  vectors.forEach((v, i) => {
    for (const [key, bucket] of Object.entries(v)) {
      const it = items[key] ?? (items[key] = { n: 0, buckets: {} });
      it.n++;
      it.buckets[bucket] = (it.buckets[bucket] ?? 0) + 1;
      const quiz = key.slice(0, key.indexOf(':'));
      (usersPerQuiz[quiz] ?? (usersPerQuiz[quiz] = new Set())).add(i);
    }
  });

  const keys = Object.keys(items).sort();
  const findings: Finding[] = [];
  for (const xk of keys) {
    for (const yk of keys) {
      if (xk === yk) continue;
      // people with both
      const both = vectors.filter((v) => xk in v && yk in v);
      const n = both.length;
      if (n < options.minGroup) continue;
      const yCounts: Record<string, number> = {};
      for (const v of both) yCounts[v[yk]] = (yCounts[v[yk]] ?? 0) + 1;
      const xBuckets = new Set(both.map((v) => v[xk]));
      for (const xb of xBuckets) {
        const group = both.filter((v) => v[xk] === xb);
        const nX = group.length;
        if (nX < options.minGroup) continue;
        for (const [yb, nY] of Object.entries(yCounts)) {
          const nXY = group.filter((v) => v[yk] === yb).length;
          if (nXY < options.minCell || nX - nXY < options.minCell) continue;
          const pY = nY / n;
          const pYgX = nXY / nX;
          const lift = pYgX / pY;
          if (lift < options.minLift && lift > 1 / options.minLift) continue;
          findings.push({
            x: { key: xk, bucket: xb }, y: { key: yk, bucket: yb },
            n, n_x: nX, n_xy: nXY,
            p_y: round(pY), p_y_given_x: round(pYgX), lift: round(lift),
          });
        }
      }
    }
  }
  findings.sort((a, b) => Math.abs(Math.log(b.lift)) - Math.abs(Math.log(a.lift)));

  const users_per_quiz: Record<string, number> = {};
  for (const [q, s] of Object.entries(usersPerQuiz)) users_per_quiz[q] = s.size;
  return { version: 1, built_at: builtAt, options, users: vectors.length, users_per_quiz, items, findings };
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/**
 * One vector per person: the latest non-anon completion per quiz, merged
 * across quizzes. `fid` restricts to one person (the report's own vector).
 */
export async function collectVectors(env: Env, fid?: number): Promise<Map<number, AnswerVector>> {
  const sql = `SELECT * FROM quiz_completions WHERE visibility != 'anon'${fid !== undefined ? ' AND user_id = ?' : ''} ORDER BY completed_at DESC`;
  const stmt = fid !== undefined ? env.DB.prepare(sql).bind(fid) : env.DB.prepare(sql);
  const rows = (await stmt.all()).results as Array<CompletionRow & { quiz_id: string }>;
  const seen = new Set<string>();
  const out = new Map<number, AnswerVector>();
  for (const row of rows) {
    if (!isMaterializedQuiz(row.quiz_id)) continue;
    const who = Number(row.user_id);
    const k = `${who}:${row.quiz_id}`;
    if (seen.has(k)) continue; // latest completion per quiz wins (rows are newest-first)
    seen.add(k);
    let answers: unknown[] | null;
    try {
      answers = await readCompletionAnswers(env, row);
    } catch (e) {
      console.warn(`[quiz-stats] completion ${row.id} would not open:`, e);
      continue;
    }
    if (!answers?.length) continue;
    const v = out.get(who) ?? {};
    Object.assign(v, vectorOf(row.quiz_id, answers));
    out.set(who, v);
  }
  return out;
}

export async function buildQuizStats(env: Env, options: StatsOptions = DEFAULT_STATS_OPTIONS): Promise<QuizStatsPayload> {
  const vectors = await collectVectors(env);
  const payload = buildStats([...vectors.values()], options);
  await env.DB.prepare(
    'INSERT INTO quiz_stats (key, payload, built_at, n) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, built_at = excluded.built_at, n = excluded.n',
  ).bind(STATS_KEY, JSON.stringify(payload), payload.built_at, payload.users).run();
  return payload;
}

export async function getQuizStats(env: Env, opts: { maxAgeMs?: number; force?: boolean } = {}): Promise<QuizStatsPayload> {
  if (!opts.force) {
    const row = await env.DB.prepare('SELECT payload, built_at FROM quiz_stats WHERE key = ?').bind(STATS_KEY).first() as { payload: string; built_at: string } | null;
    if (row) {
      const age = Date.now() - Date.parse(row.built_at);
      if (Number.isFinite(age) && age < (opts.maxAgeMs ?? STATS_MAX_AGE_MS)) {
        return JSON.parse(row.payload) as QuizStatsPayload;
      }
    }
  }
  return buildQuizStats(env);
}

// ─── personal report ───────────────────────────────────────────────────────

export interface ReportLine {
  x: { quiz: string; q_id: string; stem: string; bucket: string };
  y: { quiz: string; q_id: string; stem: string; bucket: string };
  lift: number;
  /** share of people like you (X = x) who answered Y = y */
  share: number;
  /** base rate of Y = y */
  base: number;
  n_x: number;
  n_xy: number;
  /** what you answered on Y: same bucket, a different one, or not answered */
  you: 'same' | 'different' | 'none';
}

export interface PersonalReport {
  built_at: string;
  users: number;
  users_per_quiz: Record<string, number>;
  quiz_titles: Record<string, string>;
  /** items of yours the findings could be matched against */
  my_items: number;
  lines: ReportLine[];
}

function split(key: string): { quiz: string; q_id: string } {
  const i = key.indexOf(':');
  return { quiz: key.slice(0, i), q_id: key.slice(i + 1) };
}

/**
 * Round a supporting count down to the nearest `SUPPORT_GRAIN` before it leaves
 * the server.
 *
 * The support floors already guarantee `n_x >= 10` and `n_xy >= 5`, so this can
 * never render a zero or a meaningless "1 of 5". The shape matters: the aggregate
 * is rebuilt every 8 hours and re-served with exact counts, so two builds
 * straddling a single new completion let a viewer who knows who just answered
 * read that person's bucket off the delta. Flooring to 5 makes any one person's
 * movement invisible. The stored aggregate keeps exact counts — only the
 * personal report is coarsened.
 */
const SUPPORT_GRAIN = 5;
function coarsenSupport(n: number): number {
  return Math.floor(n / SUPPORT_GRAIN) * SUPPORT_GRAIN;
}

export function personalReport(payload: QuizStatsPayload, mine: AnswerVector, limit = 12): PersonalReport {
  const lines: ReportLine[] = [];
  for (const f of payload.findings) {
    if (mine[f.x.key] !== f.x.bucket) continue;
    const x = split(f.x.key);
    const y = split(f.y.key);
    const mx = itemMeta(x.q_id);
    const my = itemMeta(y.q_id);
    if (!mx || !my) continue;
    lines.push({
      x: { ...x, stem: mx.stem, bucket: f.x.bucket },
      y: { ...y, stem: my.stem, bucket: f.y.bucket },
      lift: f.lift, share: f.p_y_given_x, base: f.p_y,
      n_x: coarsenSupport(f.n_x), n_xy: coarsenSupport(f.n_xy),
      you: f.y.key in mine ? (mine[f.y.key] === f.y.bucket ? 'same' : 'different') : 'none',
    });
  }
  // One line per (X, Y) pair so the report reads as distinct claims. For a
  // pair, a "more likely" line beats a "less likely" one (the same table read
  // the other way round), then the stronger lift; across pairs, strongest first.
  const strength = (l: ReportLine) => Math.abs(Math.log(l.lift));
  const byPair = new Map<string, ReportLine>();
  for (const l of lines) {
    const k = `${l.x.q_id}|${l.y.q_id}`;
    const cur = byPair.get(k);
    if (!cur) { byPair.set(k, l); continue; }
    const better = (l.lift > 1) !== (cur.lift > 1) ? l.lift > 1 : strength(l) > strength(cur);
    if (better) byPair.set(k, l);
  }
  const distinct = [...byPair.values()].sort((a, b) => strength(b) - strength(a));
  return {
    built_at: payload.built_at,
    users: payload.users,
    users_per_quiz: payload.users_per_quiz,
    quiz_titles: QUIZ_TITLES,
    my_items: Object.keys(mine).length,
    lines: distinct.slice(0, limit),
  };
}
