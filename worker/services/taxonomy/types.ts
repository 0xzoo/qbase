/**
 * Question typology — canonical enums and the stored taxonomy shape.
 *
 * Spec: docs/specs/question-typology.md. Five independent axes are asked of
 * the classifier; every routing label (`primary_type`, `resolvability`,
 * `signal`, `wave_relevance`, `clout_eligible`) is derived from them in
 * `derive.ts`, never asked for. `taxonomy` on `queries` is a JSON column, so
 * the axes are additive alongside the v1 fields — old rows keep working.
 */

export const REFERENTS = ['self', 'world'] as const;
export const MODES = ['stance', 'report', 'claim'] as const;
export const TENSES = ['past', 'present', 'future', 'timeless'] as const;
export const VOLATILITIES = ['stable', 'volatile', 'event'] as const;
export const INTENTS = ['measure', 'request'] as const;
export const FRAMES = ['hypothetical', 'comparative', 'normative'] as const;

export const PRIMARY_TYPES = ['identity', 'recurring', 'prospective', 'predictive', 'knowledge', 'invalid'] as const;
export const RESOLVABILITIES = ['never', 'self_only', 'later', 'now'] as const;
export const SIGNALS = ['distribution', 'time_series', 'demography', 'forecast', 'accuracy'] as const;

export const CONSTRUCTION_TYPES = ['complete', 'template', 'follow_up'] as const;
export const CONTENT_TAGS = [
  'belief', 'preference', 'behavioral', 'emotional',
  'demographic', 'social', 'evaluative', 'personal_history',
] as const;
export const SENSITIVITIES = ['low', 'medium', 'high'] as const;

export type Referent = (typeof REFERENTS)[number];
export type Mode = (typeof MODES)[number];
export type Tense = (typeof TENSES)[number];
export type Volatility = (typeof VOLATILITIES)[number];
export type Intent = (typeof INTENTS)[number];
export type Frame = (typeof FRAMES)[number];
export type PrimaryType = (typeof PRIMARY_TYPES)[number];
export type Resolvability = (typeof RESOLVABILITIES)[number];
export type Signal = (typeof SIGNALS)[number];
export type ConstructionType = (typeof CONSTRUCTION_TYPES)[number];
export type ContentTag = (typeof CONTENT_TAGS)[number];
export type Sensitivity = (typeof SENSITIVITIES)[number];

/** The five judgments the classifier makes. Everything else derives from these. */
export interface QuestionAxes {
  /** Whose state does the answer describe: the answerer, or something outside them. */
  referent: Referent;
  /** stance = no truth value; report = only the answerer can verify; claim = others can verify. */
  mode: Mode;
  /** When is the referent state. */
  tense: Tense;
  /** How fast the true answer changes: stable (months+), volatile (hours–days), event (settles once). */
  volatility: Volatility;
  /** measure = the distribution is the product; request = the best single answer is. */
  intent: Intent;
}

/** Labels derived from the axes. Recomputed, never trusted from the model. */
export interface DerivedLabels {
  primary_type: Exclude<PrimaryType, 'invalid'>;
  resolvability: Resolvability;
  signal: Signal;
  wave_relevance: boolean;
  clout_eligible: boolean;
}

/**
 * Stored taxonomy. v1 rows (3B decision tree) carry only the first block;
 * v2 rows (five-axis classifier) carry all of it.
 */
export interface QuestionTaxonomy {
  primary_type: PrimaryType;
  /** v1 only. Under the axes, `factual` is claim/measure and the rest are `intent = request`. */
  knowledge_subtype?: 'factual' | 'problem' | 'discussion' | 'advice';
  construction_type: ConstructionType;
  content_tags: ContentTag[];
  temporal_markers?: string[];
  safety_flag?: boolean;
  sensitivity?: Sensitivity;
  is_template: boolean;
  reasoning: string;
  topics: string[];

  // ── v2: axes (docs/specs/question-typology.md) ──
  referent?: Referent;
  mode?: Mode;
  tense?: Tense;
  volatility?: Volatility;
  intent?: Intent;
  frame?: Frame[];

  // ── v2: derived ──
  resolvability?: Resolvability;
  signal?: Signal;
  wave_relevance?: boolean;
  clout_eligible?: boolean;

  // ── provenance ──
  taxonomy_version?: 1 | 2;
  /** Model id that produced the axes (or the v1 label). */
  classifier?: string;
  classified_at?: string;
  /** Set by the B2 backfill when the derived label replaced a stored v1 label. */
  primary_type_v1?: PrimaryType;
}

export function isOneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (list as readonly string[]).includes(value);
}
