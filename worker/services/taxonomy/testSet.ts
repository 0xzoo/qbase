/**
 * Canonical classifier test set. Shared by the dev-only route
 * (POST /api/test/taxonomy-classification) and scripts/taxonomy-gate.ts.
 *
 * Expectations are in the canonical enum (docs/specs/question-typology.md):
 * `primary_type` is what `derive.ts` must produce; `axes` pins the judgments
 * the spec is explicit about. Where two readings are defensible,
 * `primary_type` lists both. The pre-spec `knowledge_subtype` values
 * (`prediction`, `evaluative`) and the `hypothetical` content tag are gone —
 * each now has a home on an axis or in `frame`.
 */

import type {
  ConstructionType, ContentTag, Frame, PrimaryType, QuestionAxes, QuestionTaxonomy,
} from './types';

export interface TaxonomyExpectation {
  primary_type: PrimaryType | PrimaryType[];
  axes?: Partial<QuestionAxes>;
  construction_type?: ConstructionType;
  is_template?: boolean;
  /** At least one must be present. Only checked for non-claim questions. */
  content_tags?: ContentTag[];
  /** Every listed frame must be present. */
  frame?: Frame[];
}

export interface TaxonomyTestCase {
  name: string;
  stem: string;
  options?: string[];
  expected: TaxonomyExpectation;
}

export const TAXONOMY_TEST_SET: TaxonomyTestCase[] = [
  // ── stances about the self → identity ──
  {
    name: 'identity: favorite color',
    stem: "What's your favorite color?",
    expected: { primary_type: 'identity', axes: { mode: 'stance', intent: 'measure' }, construction_type: 'complete', content_tags: ['preference'] },
  },
  {
    name: 'identity: would-you-rather template',
    stem: 'Would you rather:',
    options: ['be rich', 'be famous'],
    expected: { primary_type: 'identity', axes: { mode: 'stance' }, construction_type: 'template', is_template: true, content_tags: ['preference'] },
  },
  {
    name: 'identity: this-or-that template (colon detection)',
    stem: 'This or that:',
    options: ['cats', 'dogs'],
    expected: { primary_type: 'identity', construction_type: 'template', is_template: true, content_tags: ['preference'] },
  },
  {
    name: 'identity: religious orientation',
    stem: 'What is your religious or spiritual orientation?',
    expected: { primary_type: 'identity', axes: { referent: 'self' }, content_tags: ['belief', 'demographic'] },
  },
  {
    name: 'identity: friendship values',
    stem: 'What do you value most in a friendship?',
    expected: { primary_type: 'identity', axes: { mode: 'stance' }, content_tags: ['social', 'preference', 'belief'] },
  },
  {
    name: 'identity: weekend habits (report, stable)',
    stem: 'What do you do to relax on weekends?',
    expected: { primary_type: 'identity', axes: { referent: 'self', volatility: 'stable' }, content_tags: ['behavioral'] },
  },
  {
    name: 'identity: hypothetical era',
    stem: 'If you could live in any era of history, which would you choose?',
    expected: { primary_type: 'identity', axes: { mode: 'stance' }, content_tags: ['preference'], frame: ['hypothetical'] },
  },
  {
    name: 'identity: pizza superlative (stance about the world)',
    stem: "What's the best pizza topping?",
    expected: { primary_type: 'identity', axes: { mode: 'stance' }, content_tags: ['preference'], frame: ['comparative'] },
  },
  {
    // referent is left unpinned: "your rating of X" reads as self or world
    // with equal justification, and referent never affects routing.
    name: 'identity: rating a show (was knowledge/evaluative)',
    stem: 'How would you rate The Last of Us TV show?',
    expected: { primary_type: 'identity', axes: { mode: 'stance' }, content_tags: ['evaluative', 'preference'] },
  },
  {
    name: 'identity: worth-it judgment (was knowledge/discussion)',
    stem: 'Is Rust worth learning in 2026?',
    expected: { primary_type: 'identity', axes: { mode: 'stance' } },
  },
  {
    name: 'identity: moral verdict about the world',
    stem: 'Is Sam Bankman-Fried guilty?',
    expected: { primary_type: 'identity', axes: { referent: 'world', mode: 'stance' } },
  },
  {
    name: 'identity: open stance about the future',
    stem: 'farcaster season 3 is over. what do you want in season 4?',
    expected: { primary_type: 'identity', axes: { mode: 'stance', intent: 'measure' } },
  },
  {
    name: 'identity: vote among the asker\'s options is measure',
    stem: 'Which name should I give my dog?',
    options: ['Miso', 'Bean', 'Pixel'],
    expected: { primary_type: 'identity', axes: { mode: 'stance', intent: 'measure' } },
  },

  // ── reports about the past → identity ──
  {
    name: 'identity: past memory (COVID lockdown)',
    stem: 'How did you feel during the COVID-19 lockdown in 2020?',
    expected: { primary_type: 'identity', axes: { referent: 'self', tense: 'past' }, content_tags: ['emotional', 'personal_history', 'behavioral'] },
  },
  {
    name: 'identity: teenage self',
    stem: 'What were you like as a teenager?',
    expected: { primary_type: 'identity', axes: { referent: 'self', tense: 'past' }, content_tags: ['personal_history', 'behavioral'] },
  },
  {
    name: 'identity: 2016 worldview',
    stem: 'What was your worldview in 2016?',
    expected: { primary_type: 'identity', axes: { referent: 'self', tense: 'past' }, content_tags: ['belief', 'personal_history'] },
  },
  {
    name: 'identity: how YOU learned to code (self, not knowledge)',
    stem: 'How did YOU learn to code?',
    expected: { primary_type: 'identity', axes: { referent: 'self', tense: 'past' }, content_tags: ['behavioral', 'personal_history'] },
  },

  // ── volatile present → recurring ──
  {
    name: 'recurring: feeling today',
    stem: 'How do you feel today?',
    expected: { primary_type: 'recurring', axes: { referent: 'self', mode: 'report', tense: 'present', volatility: 'volatile' }, content_tags: ['emotional'] },
  },
  {
    name: 'recurring: feeling rn',
    stem: 'how are you feeling rn?',
    expected: { primary_type: 'recurring', axes: { referent: 'self', mode: 'report', tense: 'present', volatility: 'volatile' }, content_tags: ['emotional'] },
  },
  {
    name: 'recurring: momentary preference template',
    stem: 'Right now, would you prefer:',
    options: ['coffee', 'tea'],
    expected: { primary_type: 'recurring', axes: { tense: 'present', volatility: 'volatile' }, construction_type: 'template', is_template: true, content_tags: ['preference'] },
  },
  {
    name: 'recurring: current stress level',
    stem: "What's your current stress level?",
    expected: { primary_type: 'recurring', axes: { referent: 'self', tense: 'present', volatility: 'volatile' }, content_tags: ['emotional'] },
  },

  // ── reports about the future → prospective ──
  {
    name: 'prospective: plans for 2026',
    stem: 'What are your plans for 2026?',
    expected: { primary_type: 'prospective', axes: { referent: 'self', mode: 'report', tense: 'future' }, content_tags: ['behavioral'] },
  },
  {
    name: 'prospective: how you will vote',
    stem: "How do you think you'll vote in the next election?",
    expected: { primary_type: 'prospective', axes: { referent: 'self', mode: 'report', tense: 'future' }, content_tags: ['belief', 'behavioral'] },
  },
  {
    name: 'prospective: career in 5 years',
    stem: 'What career will you be in 5 years from now?',
    expected: { primary_type: 'prospective', axes: { referent: 'self', tense: 'future' }, content_tags: ['demographic', 'behavioral'] },
  },
  {
    name: 'prospective: will you vote this year',
    stem: 'will you vote this year?',
    expected: { primary_type: 'prospective', axes: { referent: 'self', mode: 'report', tense: 'future', volatility: 'event' } },
  },

  // ── claims about the future → predictive (were knowledge/prediction) ──
  {
    name: 'predictive: AI sentience by 2030',
    stem: 'Will AI become sentient by 2030?',
    expected: { primary_type: 'predictive', axes: { referent: 'world', mode: 'claim', tense: 'future', intent: 'measure' } },
  },
  {
    name: 'predictive: 2028 election',
    stem: 'Who will win the 2028 US presidential election?',
    expected: { primary_type: 'predictive', axes: { mode: 'claim', tense: 'future', volatility: 'event' } },
  },
  {
    name: 'predictive: bitcoin in 5 years',
    stem: 'What will Bitcoin be worth in 5 years?',
    expected: { primary_type: 'predictive', axes: { mode: 'claim', tense: 'future' } },
  },
  {
    // Phrased in the present, checkable only in hindsight → a forecast.
    // Re-askability is wave_relevance (true here), not the primary_type.
    name: 'predictive: is the bottom in (present-phrased, settles later)',
    stem: 'is the bottom in? 🫣',
    options: ['Yes', 'No'],
    expected: { primary_type: 'predictive', axes: { mode: 'claim', tense: 'future', volatility: 'event', intent: 'measure' } },
  },
  {
    name: 'predictive: gonna be a big week',
    stem: 'gonna be a big week?',
    expected: { primary_type: 'predictive', axes: { mode: 'claim', tense: 'future', intent: 'measure' } },
  },

  // ── claims about the present/timeless → knowledge ──
  {
    name: 'knowledge: capital of Peru (quiz, measure)',
    stem: "What's the capital of Peru?",
    expected: { primary_type: 'knowledge', axes: { mode: 'claim', volatility: 'event' } },
  },
  {
    name: 'knowledge: how TCP/IP works (explanation → request)',
    stem: 'How does TCP/IP work?',
    expected: { primary_type: 'knowledge', axes: { mode: 'claim', intent: 'request' } },
  },
  {
    name: 'knowledge: fix a cargo error (request)',
    stem: 'how do I fix this cargo error? "error[E0382]: borrow of moved value"',
    expected: { primary_type: 'knowledge', axes: { mode: 'claim', intent: 'request' } },
  },

  // ── requests where the mode is arguable: pin intent, accept either routing ──
  {
    // First person pins it as advice-seeking; the bare "what's the best way to
    // learn Rust?" flips between measure and request across runs.
    name: 'request: best way for me to learn Rust (advice)',
    stem: "What's the best way for me to learn Rust? I already know Python.",
    expected: { primary_type: ['knowledge', 'identity'], axes: { intent: 'request' } },
  },
  {
    name: 'request: laptop recommendation',
    stem: 'Which laptop should I buy for video editing under $1500?',
    expected: { primary_type: ['knowledge', 'identity'], axes: { intent: 'request' } },
  },
  {
    name: 'measure: open questions in science (stance, measure)',
    stem: 'What are the most interesting open questions in science?',
    expected: { primary_type: ['identity', 'knowledge'], axes: { intent: 'measure' } },
  },

  // ── answerable non-questions: Likert items and open prompts (registered quiz queries) ──
  {
    name: 'identity: likert statement (values quiz item)',
    stem: 'i prefer routines that work over experiments that might not',
    expected: { primary_type: 'identity', axes: { referent: 'self', tense: 'timeless', volatility: 'stable', intent: 'measure' } },
  },
  {
    name: 'identity: open prompt (confess here)',
    stem: 'confess here',
    expected: { primary_type: ['identity', 'recurring'], axes: { referent: 'self', intent: 'measure' } },
  },

  // ── not a question ──
  {
    name: 'invalid: gibberish',
    stem: 'asdf qwerty zxcv',
    expected: { primary_type: 'invalid' },
  },
];

/** Compare a classifier result to an expectation. Returns a list of mismatches (empty = pass). */
export function checkTaxonomy(result: QuestionTaxonomy, expected: TaxonomyExpectation): string[] {
  const errors: string[] = [];
  const acceptable = Array.isArray(expected.primary_type) ? expected.primary_type : [expected.primary_type];
  if (!acceptable.includes(result.primary_type)) {
    errors.push(`primary_type: expected ${acceptable.join('|')}, got ${result.primary_type}`);
  }
  if (result.primary_type === 'invalid' || expected.primary_type === 'invalid') return errors;

  if (expected.axes) {
    for (const [axis, want] of Object.entries(expected.axes)) {
      const got = (result as unknown as Record<string, unknown>)[axis];
      if (got === undefined) {
        errors.push(`${axis}: expected ${want}, classifier returned no axes`);
      } else if (got !== want) {
        errors.push(`${axis}: expected ${want}, got ${got}`);
      }
    }
  }
  if (expected.construction_type && result.construction_type !== expected.construction_type) {
    errors.push(`construction_type: expected ${expected.construction_type}, got ${result.construction_type}`);
  }
  if (expected.is_template !== undefined && result.is_template !== expected.is_template) {
    errors.push(`is_template: expected ${expected.is_template}, got ${result.is_template}`);
  }
  if (expected.content_tags && result.mode !== 'claim') {
    const has = expected.content_tags.some((t) => result.content_tags.includes(t));
    if (!has) {
      errors.push(`content_tags: expected one of [${expected.content_tags.join(', ')}], got [${result.content_tags.join(', ')}]`);
    }
  }
  if (expected.frame) {
    for (const f of expected.frame) {
      if (!(result.frame ?? []).includes(f)) errors.push(`frame: expected ${f}, got [${(result.frame ?? []).join(', ')}]`);
    }
  }
  return errors;
}
