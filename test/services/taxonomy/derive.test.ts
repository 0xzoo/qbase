/**
 * Derivations are the contract between the classifier and the rest of the
 * system: every routing label comes from these functions, never from the
 * model. The worked examples in docs/specs/question-typology.md are pinned
 * here, plus the volatile-stance refinement (see derive.ts header).
 */

import { describe, it, expect } from 'vitest';
import {
  deriveCloutEligible, deriveLabels, derivePrimaryType, deriveResolvability,
  deriveSignal, deriveWaveRelevance, parseAxes,
} from '../../../worker/services/taxonomy/derive';
import type { QuestionAxes } from '../../../worker/services/taxonomy/types';

const ax = (partial: Partial<QuestionAxes>): QuestionAxes => ({
  referent: 'self', mode: 'stance', tense: 'timeless', volatility: 'stable', intent: 'measure',
  ...partial,
});

describe('derivePrimaryType — spec worked examples', () => {
  it('"gonna be a big week?" → predictive', () => {
    expect(derivePrimaryType(ax({ referent: 'world', mode: 'claim', tense: 'future', volatility: 'event' }))).toBe('predictive');
  });
  it('"how are you feeling rn?" → recurring', () => {
    expect(derivePrimaryType(ax({ mode: 'report', tense: 'present', volatility: 'volatile' }))).toBe('recurring');
  });
  it('"will you vote this year?" → prospective', () => {
    expect(derivePrimaryType(ax({ mode: 'report', tense: 'future', volatility: 'event' }))).toBe('prospective');
  });
  it('"do you like pineapple pizza?" → identity', () => {
    expect(derivePrimaryType(ax({ mode: 'stance' }))).toBe('identity');
  });
  it('"is X guilty?" → identity (stance about the world, no special case)', () => {
    expect(derivePrimaryType(ax({ referent: 'world', mode: 'stance', tense: 'past' }))).toBe('identity');
  });
  it('"what\'s the capital of Peru?" → knowledge', () => {
    expect(derivePrimaryType(ax({ referent: 'world', mode: 'claim', volatility: 'event' }))).toBe('knowledge');
  });
  it('"how do I fix this cargo error?" → knowledge (request)', () => {
    expect(derivePrimaryType(ax({ referent: 'world', mode: 'claim', tense: 'present', volatility: 'event', intent: 'request' }))).toBe('knowledge');
  });
  it('"what do you want in season 4?" → identity', () => {
    expect(derivePrimaryType(ax({ referent: 'world', mode: 'stance', tense: 'future' }))).toBe('identity');
  });
});

describe('derivePrimaryType — refinements', () => {
  it('a volatile present-tense stance is recurring, not identity ("right now, coffee or tea?")', () => {
    expect(derivePrimaryType(ax({ mode: 'stance', tense: 'present', volatility: 'volatile' }))).toBe('recurring');
  });
  it('a stable present-tense report is identity ("what do you do to relax on weekends?")', () => {
    expect(derivePrimaryType(ax({ mode: 'report', tense: 'present', volatility: 'stable' }))).toBe('identity');
  });
  it('a past report is identity ("what were you like as a teenager?")', () => {
    expect(derivePrimaryType(ax({ mode: 'report', tense: 'past' }))).toBe('identity');
  });
  it('a volatile past report is recurring ("how did you sleep last night?")', () => {
    expect(derivePrimaryType(ax({ mode: 'report', tense: 'past', volatility: 'volatile' }))).toBe('recurring');
  });
  it('a volatile future report is prospective, not recurring ("what are you doing tonight?")', () => {
    expect(derivePrimaryType(ax({ mode: 'report', tense: 'future', volatility: 'volatile' }))).toBe('prospective');
  });
  it('a claim about the past is knowledge, never predictive', () => {
    expect(derivePrimaryType(ax({ referent: 'world', mode: 'claim', tense: 'past', volatility: 'event' }))).toBe('knowledge');
  });
  it('referent never changes routing', () => {
    for (const referent of ['self', 'world'] as const) {
      expect(derivePrimaryType(ax({ referent, mode: 'claim', tense: 'future' }))).toBe('predictive');
      expect(derivePrimaryType(ax({ referent, mode: 'report', tense: 'present', volatility: 'volatile' }))).toBe('recurring');
    }
  });
});

describe('deriveResolvability', () => {
  it('stance → never', () => expect(deriveResolvability(ax({ mode: 'stance' }))).toBe('never'));
  it('report → self_only', () => expect(deriveResolvability(ax({ mode: 'report', tense: 'future' }))).toBe('self_only'));
  it('claim/future → later', () => expect(deriveResolvability(ax({ mode: 'claim', tense: 'future' }))).toBe('later'));
  it('claim/present|past|timeless → now', () => {
    for (const tense of ['present', 'past', 'timeless'] as const) {
      expect(deriveResolvability(ax({ mode: 'claim', tense }))).toBe('now');
    }
  });
});

describe('deriveSignal', () => {
  it('stance/stable → distribution', () => expect(deriveSignal(ax({}))).toBe('distribution'));
  it('report/volatile → time_series', () => expect(deriveSignal(ax({ mode: 'report', volatility: 'volatile' }))).toBe('time_series'));
  it('stance/volatile → time_series', () => expect(deriveSignal(ax({ mode: 'stance', volatility: 'volatile' }))).toBe('time_series'));
  it('report/stable → demography', () => expect(deriveSignal(ax({ mode: 'report' }))).toBe('demography'));
  it('claim/future → forecast', () => expect(deriveSignal(ax({ mode: 'claim', tense: 'future' }))).toBe('forecast'));
  it('claim/now → accuracy', () => expect(deriveSignal(ax({ mode: 'claim' }))).toBe('accuracy'));
});

describe('deriveWaveRelevance', () => {
  it('stance/stable, report/volatile, claim/future → yes', () => {
    expect(deriveWaveRelevance(ax({}))).toBe(true);
    expect(deriveWaveRelevance(ax({ mode: 'report', volatility: 'volatile' }))).toBe(true);
    expect(deriveWaveRelevance(ax({ mode: 'claim', tense: 'future' }))).toBe(true);
  });
  it('claim/now → no', () => expect(deriveWaveRelevance(ax({ mode: 'claim' }))).toBe(false));
  it('request → no, whatever the axes', () => {
    expect(deriveWaveRelevance(ax({ intent: 'request' }))).toBe(false);
    expect(deriveWaveRelevance(ax({ mode: 'claim', tense: 'future', intent: 'request' }))).toBe(false);
  });
});

describe('deriveCloutEligible', () => {
  it('only a measured claim about the future mints clout', () => {
    expect(deriveCloutEligible(ax({ mode: 'claim', tense: 'future' }))).toBe(true);
  });
  it('knowledge mints nothing', () => expect(deriveCloutEligible(ax({ mode: 'claim' }))).toBe(false));
  it('a requested forecast mints nothing', () => {
    expect(deriveCloutEligible(ax({ mode: 'claim', tense: 'future', intent: 'request' }))).toBe(false);
  });
  it('stances and reports mint nothing', () => {
    expect(deriveCloutEligible(ax({ mode: 'stance', tense: 'future' }))).toBe(false);
    expect(deriveCloutEligible(ax({ mode: 'report', tense: 'future' }))).toBe(false);
  });
});

describe('deriveLabels', () => {
  it('bundles all five labels', () => {
    expect(deriveLabels(ax({ referent: 'world', mode: 'claim', tense: 'future', volatility: 'event' }))).toEqual({
      primary_type: 'predictive', resolvability: 'later', signal: 'forecast', wave_relevance: true, clout_eligible: true,
    });
  });
});

describe('parseAxes', () => {
  it('accepts a full valid object and normalizes case/whitespace', () => {
    expect(parseAxes({ referent: ' Self', mode: 'STANCE', tense: 'timeless', volatility: 'stable', intent: 'measure' }))
      .toEqual({ referent: 'self', mode: 'stance', tense: 'timeless', volatility: 'stable', intent: 'measure' });
  });
  it('rejects a missing axis', () => {
    expect(parseAxes({ referent: 'self', mode: 'stance', tense: 'timeless', volatility: 'stable' })).toBeNull();
  });
  it('rejects an out-of-enum value', () => {
    expect(parseAxes({ referent: 'self', mode: 'opinion', tense: 'timeless', volatility: 'stable', intent: 'measure' })).toBeNull();
  });
  it('rejects non-objects', () => {
    expect(parseAxes(null)).toBeNull();
    expect(parseAxes('self')).toBeNull();
  });
});
