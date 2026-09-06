/**
 * Deterministic derivations from the five axes.
 *
 * Spec: docs/specs/question-typology.md § Derivations. One deliberate
 * refinement over the spec's table: a *volatile, present-tense* question is
 * `recurring` whether its mode is `report` (mood) or `stance` ("right now,
 * coffee or tea?"). Both are time-series per user; routing a momentary
 * stance to `identity` would collapse it to one canonical answer and lose
 * the series. `referent` plays no part in routing (spec open question 1) —
 * it is kept for the sociology.
 */

import {
  INTENTS, MODES, REFERENTS, TENSES, VOLATILITIES,
  isOneOf,
  type DerivedLabels,
  type QuestionAxes,
} from './types';

export function derivePrimaryType(a: QuestionAxes): DerivedLabels['primary_type'] {
  if (a.mode === 'claim') return a.tense === 'future' ? 'predictive' : 'knowledge';
  if (a.tense === 'present' && a.volatility === 'volatile') return 'recurring';
  if (a.mode === 'report' && a.tense === 'future') return 'prospective';
  return 'identity';
}

/** What the resolution layer keys on. */
export function deriveResolvability(a: QuestionAxes): DerivedLabels['resolvability'] {
  if (a.mode === 'stance') return 'never';
  if (a.mode === 'report') return 'self_only';
  return a.tense === 'future' ? 'later' : 'now';
}

/** What the aggregate *means*; drives which results view is primary. */
export function deriveSignal(a: QuestionAxes): DerivedLabels['signal'] {
  if (a.mode === 'claim') return a.tense === 'future' ? 'forecast' : 'accuracy';
  if (a.volatility === 'volatile') return 'time_series';
  return a.mode === 'stance' ? 'distribution' : 'demography';
}

/** Should "re-ask as a fresh wave" be offered? Drift across waves is the signal. */
export function deriveWaveRelevance(a: QuestionAxes): boolean {
  if (a.intent === 'request') return false;
  if (a.mode === 'claim') return a.tense === 'future';
  return true;
}

/** Only resolved, measured predictions mint clout. Knowledge and requests never do. */
export function deriveCloutEligible(a: QuestionAxes): boolean {
  return a.mode === 'claim' && a.tense === 'future' && a.intent === 'measure';
}

export function deriveLabels(a: QuestionAxes): DerivedLabels {
  return {
    primary_type: derivePrimaryType(a),
    resolvability: deriveResolvability(a),
    signal: deriveSignal(a),
    wave_relevance: deriveWaveRelevance(a),
    clout_eligible: deriveCloutEligible(a),
  };
}

/**
 * Validate a raw object's five axes against their enums. Returns null if any
 * axis is missing or outside its enum — the caller treats that as `invalid`
 * (the spec: fall back to invalid only when the *axes* are unparseable).
 */
export function parseAxes(raw: unknown): QuestionAxes | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const norm = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : v);
  const referent = norm(o.referent);
  const mode = norm(o.mode);
  const tense = norm(o.tense);
  const volatility = norm(o.volatility);
  const intent = norm(o.intent);
  if (
    !isOneOf(REFERENTS, referent) ||
    !isOneOf(MODES, mode) ||
    !isOneOf(TENSES, tense) ||
    !isOneOf(VOLATILITIES, volatility) ||
    !isOneOf(INTENTS, intent)
  ) {
    return null;
  }
  return { referent, mode, tense, volatility, intent };
}
