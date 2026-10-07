/**
 * get_context — the owner's record, cut to one decision (docs/specs/personal-mcp.md §3.6).
 *
 * Pure: the caller loads the record (`record.ts` in the worker, the prototype
 * script against prod D1) and supplies vectors; this module groups, filters by
 * the grant, ranks and shapes the bundle. Nothing here touches env.
 *
 * Retrieval is by decision, not by similarity to it: `select.ts` reads the
 * owner's question stems against the decision and returns the ones that bear
 * on it, most relevant first, plus the gaps (what to ask, P1 `ask_owner`).
 * Embeddings only recall candidates when a record is too big for one prompt.
 */

import type { QuestionTaxonomy } from '../taxonomy/types';

export type Tier = 'Public' | 'Anon' | 'Secret';
export const TIER_RANK: Record<Tier, number> = { Public: 0, Anon: 1, Secret: 2 };

/** Answers.audience → the tier a grant's ceiling is compared against. Allowlist is sealed like Secret. */
export function tierOf(audience: string): Tier {
  if (audience === 'Public') return 'Public';
  if (audience === 'Anon') return 'Anon';
  return 'Secret';
}

export function withinCeiling(audience: string, ceiling: Tier): boolean {
  return TIER_RANK[tierOf(audience)] <= TIER_RANK[ceiling];
}

export type Group = 'values' | 'preferences' | 'beliefs' | 'facts' | 'goals' | 'recent' | 'expertise' | 'other';
export const GROUPS: Group[] = ['values', 'preferences', 'beliefs', 'facts', 'goals', 'recent', 'expertise', 'other'];

export interface RecordAnswer {
  id: string;
  q_id: string;
  stem: string;
  question_type: string | null;
  /** MC / checkbox option labels; quiz stems ("which would you rather?") mean nothing without them. */
  options: string[] | null;
  scale_config: ScaleConfig | null;
  /** Opened value; null when a sealed row could not be opened. */
  value: unknown;
  reasoning: string | null;
  audience: string;
  created_at: string;
  poll_id: string | null;
  /** 'quiz' rows are the per-item answers a quiz completion wrote. */
  source: 'feed' | 'quiz';
  taxonomy: Partial<QuestionTaxonomy> | null;
  /** The stem itself is sealed (P1 owner-only questions, personal-mcp §3.2): never sent to the selector. */
  stem_sealed?: boolean;
}

export interface ScaleConfig {
  min?: number;
  max?: number;
  customLabels?: Array<{ value: number; label: string }>;
  minLabel?: string;
  maxLabel?: string;
}

/**
 * The text a question is embedded under. Options join the stem for choice
 * questions: "which do you enjoy more?" alone matches every decision.
 */
export function embedText(stem: string, options: string[] | null | undefined): string {
  const s = stem.trim();
  return options && options.length > 0 ? `${s} (${options.join(' / ')})` : s;
}

/** A scale answer in words ("agree"), when the question's scale names its points. */
export function scaleLabel(value: unknown, sc: ScaleConfig | null): string | undefined {
  const n = Number(value);
  if (!sc || !Number.isFinite(n)) return undefined;
  const hit = sc.customLabels?.find((l) => l.value === n);
  if (hit) return hit.label;
  const range = sc.min !== undefined && sc.max !== undefined ? ` on ${sc.min}–${sc.max}` : '';
  const ends = sc.minLabel && sc.maxLabel ? ` (${sc.min} = ${sc.minLabel}, ${sc.max} = ${sc.maxLabel})` : '';
  return range ? `${n}${range}${ends}` : undefined;
}

export interface AuthoredQuestion {
  id: string;
  stem: string;
  created_at: string;
  taxonomy: Partial<QuestionTaxonomy> | null;
  /** See RecordAnswer.stem_sealed. */
  stem_sealed?: boolean;
}

export interface MeasuredResult {
  quiz_id: string;
  completed_at: string;
  result: string | null;
  scores: Record<string, unknown> | null;
  /** quiz_completions.visibility: 'public' shows on the profile; anything else is owner-only on the site. */
  visibility: string;
}

/**
 * Quiz results a grant may see. Scores are derived from the completion's
 * answers, and "a derived summary of Secret answers is itself Secret"
 * (consent-model.md §3.7): a private completion counts as Secret, a public
 * one as Public, matching what /api/quiz-completions shows a non-owner. Quiz
 * results carry no topics, so a domain-scoped grant gets none.
 */
export function measuredFor(record: OwnerRecord, grant: Grant): MeasuredItem[] {
  if (grant.domains !== '*') return [];
  return record.measured
    .filter((m) => {
      // A tier, not an audience: don't route this through tierOf's fail-closed default.
      const tier: Tier = m.visibility === 'public' ? 'Public' : 'Secret';
      return TIER_RANK[tier] <= TIER_RANK[grant.ceiling];
    })
    .map(({ visibility: _v, ...m }) => ({ ...m, provenance: 'measured' as const }));
}

export interface OwnerRecord {
  answers: RecordAnswer[];
  authored: AuthoredQuestion[];
  measured: MeasuredResult[];
}

export interface Grant {
  id: string;
  disclosure: 'derived' | 'raw';
  ceiling: Tier;
  /** '*' or a list of topic strings; a question passes when any of its topics is listed. */
  domains: '*' | string[];
}

/** Volatile state ("how are you feeling today?") is only worth returning while it's fresh. */
export const RECENT_DAYS = 21;
const DAY = 86_400_000;

/** Which kind of position a question holds, from its typology (question-typology.md). */
export function groupOf(t: Partial<QuestionTaxonomy> | null): Group {
  if (!t) return 'other';
  if (t.primary_type === 'prospective') return 'goals';
  if (t.mode === 'claim') return 'beliefs';
  if (t.mode === 'report') return t.volatility === 'volatile' ? 'recent' : 'facts';
  if (t.mode === 'stance') {
    return t.referent === 'self' && t.content_tags?.includes('preference') ? 'preferences' : 'values';
  }
  // v1 rows carry only primary_type.
  if (t.primary_type === 'recurring') return 'recent';
  if (t.primary_type === 'knowledge' || t.primary_type === 'predictive') return 'beliefs';
  if (t.primary_type === 'identity') return 'values';
  return 'other';
}

export function inDomains(t: Partial<QuestionTaxonomy> | null, domains: Grant['domains']): boolean {
  if (domains === '*') return true;
  const topics = (t?.topics ?? []).map((s) => s.toLowerCase());
  return domains.some((d) => topics.includes(d.toLowerCase()));
}

export interface Position {
  question_id: string;
  stem: string;
  group: Group;
  /** The owner's latest answer on the question. */
  answer: unknown;
  /** Scale answers in words. */
  answer_label?: string;
  /** What else they could have picked. */
  options?: string[];
  reasoning: string | null;
  answered_at: string;
  tier: Tier;
  source: 'feed' | 'quiz';
  /** Every answer is the owner's own words: stated. (Derived items say measured / inferred.) */
  provenance: 'stated';
  /** Earlier answers, newest first, when the owner changed their mind. Facts carry only the count. */
  history?: Array<{ answer: unknown; at: string }>;
  earlier: number;
  /** How it bears on the decision (from the selection step). */
  why: string;
}

/**
 * Latest answer per question with its history, after the grant's ceiling and
 * domains. Volatile answers older than RECENT_DAYS are counted as `stale` and
 * left out unless `includeStale` (listings want them; a decision doesn't).
 */
export function positionsOf(record: OwnerRecord, grant: Grant, now = Date.now(), opts: { includeStale?: boolean } = {}): {
  positions: Omit<Position, 'why'>[];
  stale: number;
} {
  const byQ = new Map<string, RecordAnswer[]>();
  for (const a of record.answers) {
    if (!withinCeiling(a.audience, grant.ceiling)) continue;
    if (!inDomains(a.taxonomy, grant.domains)) continue;
    const list = byQ.get(a.q_id) ?? [];
    list.push(a);
    byQ.set(a.q_id, list);
  }
  const positions: Omit<Position, 'why'>[] = [];
  let stale = 0;
  for (const rows of byQ.values()) {
    rows.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
    const [latest, ...older] = rows;
    const group = groupOf(latest.taxonomy);
    if (group === 'recent' && now - Date.parse(latest.created_at) > RECENT_DAYS * DAY) {
      stale++;
      if (!opts.includeStale) continue;
    }
    const p: Omit<Position, 'why'> = {
      question_id: latest.q_id,
      stem: latest.stem.trim(),
      group,
      answer: latest.value,
      ...(latest.question_type === 'scale' && scaleLabel(latest.value, latest.scale_config)
        ? { answer_label: scaleLabel(latest.value, latest.scale_config) } : {}),
      ...(latest.options?.length ? { options: latest.options } : {}),
      reasoning: latest.reasoning,
      answered_at: latest.created_at,
      tier: tierOf(latest.audience),
      source: latest.source,
      provenance: 'stated',
      earlier: older.length,
    };
    if (group !== 'facts' && older.length > 0) {
      // Only changes of mind: a repeated identical answer adds a date, not a position.
      const changes: Array<{ answer: unknown; at: string }> = [];
      let prev = JSON.stringify(latest.value);
      for (const o of older) {
        const v = JSON.stringify(o.value);
        if (v !== prev) changes.push({ answer: o.value, at: o.created_at });
        prev = v;
      }
      if (changes.length) p.history = changes.slice(0, 5);
    }
    positions.push(p);
  }
  return { positions, stale };
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export interface Candidate {
  id: string;
  text: string;
}

/**
 * What the selection step may read: one entry per question the grant lets the
 * consumer see (answered within the ceiling and domains, or asked by the
 * owner), as stem + options.
 *
 * Invariant: candidates go to a third-party model (select.ts), so they are
 * public question text only. Answers never; a sealed stem never, even the
 * owner's own (a stem can leak as much as its answer, personal-mcp §3.2).
 * Records mark sealed stems with `stem_sealed`; P1's owner-only questions must
 * set it in record.ts, and they need a selection path that stays inside qbase.
 */
export function candidatesOf(record: OwnerRecord, grant: Grant, now = Date.now()): Candidate[] {
  const sealedStem = new Set(record.answers.filter((a) => a.stem_sealed).map((a) => a.q_id));
  const out = new Map<string, Candidate>();
  for (const p of positionsOf(record, grant, now).positions) {
    if (sealedStem.has(p.question_id)) continue;
    out.set(p.question_id, { id: p.question_id, text: embedText(p.stem, p.options) });
  }
  for (const q of record.authored) {
    if (q.stem_sealed || out.has(q.id) || sealedStem.has(q.id) || !inDomains(q.taxonomy, grant.domains)) continue;
    out.set(q.id, { id: q.id, text: q.stem.trim() });
  }
  return [...out.values()];
}

/**
 * Embedding recall for records too big for one selection prompt: the `k`
 * candidates nearest any probe. Coarse on purpose (see select.ts): it only
 * decides what the judge reads.
 */
export function recallByProbes(
  candidates: Candidate[], vectors: Map<string, ArrayLike<number>>, probes: ArrayLike<number>[], k: number,
): Candidate[] {
  if (candidates.length <= k) return candidates;
  return candidates
    .map((c) => {
      const v = vectors.get(c.id);
      return { c, score: v ? Math.max(...probes.map((p) => cosine(v, p))) : -1 };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((x) => x.c);
}

export const PER_GROUP = 8;

export interface MeasuredItem {
  quiz_id: string;
  result: string | null;
  scores: Record<string, unknown> | null;
  completed_at: string;
  provenance: 'measured';
}

export interface ContextBundle {
  decision: string;
  disclosure: Grant['disclosure'];
  ceiling: Tier;
  /** Positions grouped by kind, most relevant first within a group; absent under a `derived` grant. */
  groups?: Partial<Record<Group, Position[]>>;
  /** Questions the owner asked that bear on the decision: what they're learning or deciding. */
  asked?: Array<{ question_id: string; stem: string; asked_at: string; why: string }>;
  /** Quiz results (values radar, bartlet, apperception), cut by `measuredFor`: a private completion is Secret, and a domain-scoped grant gets none. */
  measured: MeasuredItem[];
  coverage: {
    /** How many of the owner's positions bear on the decision, per group. */
    relevant: Partial<Record<Group, number>>;
    /** What the owner hasn't answered that would change the advice: ask them (P1 ask_owner) rather than guess. */
    gaps: string[];
    /** Volatile answers too old to count (RECENT_DAYS). */
    stale_omitted: number;
    answered_total: number;
  };
  /** 'model' when the selection step ran; 'fallback' when it failed and nothing was selected. */
  selection: 'model' | 'fallback';
  /** How the agent should read this. */
  note: string;
}

export interface BuildInput {
  decision: string;
  record: OwnerRecord;
  grant: Grant;
  /** From select.ts: question ids most relevant first, each with why. */
  selected: Array<{ id: string; why: string }>;
  gaps: string[];
  selection: 'model' | 'fallback';
  now?: number;
  perGroup?: number;
}

export function buildContext(input: BuildInput): ContextBundle {
  const { decision, record, grant } = input;
  const perGroup = input.perGroup ?? PER_GROUP;
  const { positions, stale } = positionsOf(record, grant, input.now);
  const byId = new Map(positions.map((p) => [p.question_id, p]));
  const authored = new Map(
    record.authored.filter((q) => inDomains(q.taxonomy, grant.domains)).map((q) => [q.id, q]),
  );

  const groups: Partial<Record<Group, Position[]>> = {};
  const relevant: Partial<Record<Group, number>> = {};
  const asked: NonNullable<ContextBundle['asked']> = [];
  for (const { id, why } of input.selected) {
    const p = byId.get(id);
    if (p) {
      relevant[p.group] = (relevant[p.group] ?? 0) + 1;
      const list = groups[p.group] ?? (groups[p.group] = []);
      if (list.length < perGroup) list.push({ ...p, why });
    }
    const q = authored.get(id);
    if (q && !p && asked.length < perGroup) asked.push({ question_id: q.id, stem: q.stem.trim(), asked_at: q.created_at, why });
  }

  const bundle: ContextBundle = {
    decision,
    disclosure: grant.disclosure,
    ceiling: grant.ceiling,
    measured: measuredFor(record, grant),
    coverage: { relevant, gaps: input.gaps, stale_omitted: stale, answered_total: positions.length + stale },
    selection: input.selection,
    note:
      'Positions are the owner\'s own answers (provenance "stated"), each dated; `history` lists earlier answers ' +
      'when they changed their mind. Measured items are quiz scores. Weigh old answers on fast-moving topics lightly. ' +
      '`gaps` are what the owner has not answered that would change the advice: ask them rather than guess.' +
      (input.selection === 'fallback' ? ' Selection was unavailable, so no positions were picked: use list_my_answers or search_my_positions.' : ''),
  };
  if (grant.disclosure === 'raw') {
    bundle.groups = groups;
    bundle.asked = asked;
  }
  return bundle;
}
