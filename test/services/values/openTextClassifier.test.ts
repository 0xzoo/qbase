/**
 * Tests for the values open-text classifier helpers.
 *
 * The actual LLM call (`classifyOpenText`) integrates with Workers AI and is
 * exercised via integration not unit tests. These tests cover the pure
 * pieces — answer collection, prompt construction, response parsing —
 * which is where format drift bugs live.
 */

import { describe, it, expect } from 'vitest';
import {
  buildClassifierPrompt,
  collectOpenAnswers,
  parseClassifierResponse,
} from '../../../worker/services/values/openTextClassifier';
import { valuesQuestions } from '../../../worker/services/values/questions';
import type { ValuesAnswer } from '../../../worker/services/values/scoring';

const SAMPLE_ANSWERS: ValuesAnswer[] = [
  { questionId: 'q_values_hard_right', type: 'open', text: 'turned down a job to stay close to family' },
  { questionId: 'q_values_unpopular_belief', type: 'open', text: '   ' }, // whitespace-only — should be skipped
  { questionId: 'q_values_fix_world', type: 'open', text: 'less hierarchy in everyday institutions' },
];

describe('collectOpenAnswers', () => {
  it('returns only non-empty open answers paired with their stems', () => {
    const items = collectOpenAnswers(SAMPLE_ANSWERS);
    expect(items.length).toBe(2);
    expect(items[0].text).toBe('turned down a job to stay close to family');
    // Second non-empty answer is fix_world (the middle one was whitespace).
    expect(items[1].text).toBe('less hierarchy in everyday institutions');
    // Stems should match what's in the question bank.
    const stems = new Set(valuesQuestions.map((q) => q.stem));
    expect(stems.has(items[0].stem)).toBe(true);
    expect(stems.has(items[1].stem)).toBe(true);
  });

  it('returns empty array when no open answers are populated', () => {
    const empties: ValuesAnswer[] = [
      { questionId: 'q_values_hard_right', type: 'open', text: '' },
      { questionId: 'q_values_fix_world', type: 'open', text: '   \n  ' },
    ];
    expect(collectOpenAnswers(empties)).toEqual([]);
  });

  it('ignores non-open answer types', () => {
    const mixed: ValuesAnswer[] = [
      { questionId: 'q_values_own_mistakes', type: 'likert', position: 4 },
      { questionId: 'q_values_year_off', type: 'forced', optionIndex: 0 },
      { questionId: 'q_values_hard_right', type: 'open', text: 'a real answer' },
    ];
    const items = collectOpenAnswers(mixed);
    expect(items.length).toBe(1);
    expect(items[0].text).toBe('a real answer');
  });
});

describe('buildClassifierPrompt', () => {
  it('contains all 5 dim names', () => {
    const items = collectOpenAnswers(SAMPLE_ANSWERS);
    const prompt = buildClassifierPrompt(items);
    for (const d of ['autonomy', 'care', 'openness', 'mastery', 'universalism']) {
      expect(prompt).toContain(d);
    }
  });

  it('embeds each non-empty answer with its question stem', () => {
    const items = collectOpenAnswers(SAMPLE_ANSWERS);
    const prompt = buildClassifierPrompt(items);
    expect(prompt).toContain('turned down a job to stay close to family');
    expect(prompt).toContain('less hierarchy in everyday institutions');
  });

  it('asks for JSON output with the 5 keys', () => {
    const prompt = buildClassifierPrompt([{ stem: 'x', text: 'y' }]);
    expect(prompt).toContain('Return JSON');
    expect(prompt).toContain('"autonomy"');
    expect(prompt).toContain('"universalism"');
  });
});

describe('parseClassifierResponse', () => {
  it('parses a valid JSON object string', () => {
    const raw = '{"autonomy": 0.8, "care": 0.4, "openness": 0.6, "mastery": 0.5, "universalism": 0.7}';
    const parsed = parseClassifierResponse(raw);
    expect(parsed).toEqual({
      autonomy: 0.8, care: 0.4, openness: 0.6, mastery: 0.5, universalism: 0.7,
    });
  });

  it('extracts JSON from prose-wrapped output', () => {
    const raw = `Here are the scores:\n{"autonomy": 0.9, "care": 0.5, "openness": 0.5, "mastery": 0.5, "universalism": 0.6}\nHope that helps.`;
    const parsed = parseClassifierResponse(raw);
    expect(parsed?.autonomy).toBe(0.9);
    expect(parsed?.universalism).toBe(0.6);
  });

  it('accepts already-parsed object input (Workers AI sometimes returns objects)', () => {
    const raw = { autonomy: 0.5, care: 0.5, openness: 0.5, mastery: 0.5, universalism: 0.5 };
    const parsed = parseClassifierResponse(raw);
    expect(parsed?.autonomy).toBe(0.5);
  });

  it('clamps values into [0, 1]', () => {
    const raw = '{"autonomy": 1.5, "care": -0.3, "openness": 0.5, "mastery": 0.5, "universalism": 0.5}';
    const parsed = parseClassifierResponse(raw);
    expect(parsed?.autonomy).toBe(1);
    expect(parsed?.care).toBe(0);
  });

  it('returns null for unparseable output', () => {
    expect(parseClassifierResponse('this is not json')).toBeNull();
    expect(parseClassifierResponse('')).toBeNull();
    expect(parseClassifierResponse(null)).toBeNull();
  });

  it('returns null when a dim key is missing or non-numeric', () => {
    const raw = '{"autonomy": 0.5, "care": "high", "openness": 0.5, "mastery": 0.5, "universalism": 0.5}';
    expect(parseClassifierResponse(raw)).toBeNull();
    const missing = '{"autonomy": 0.5, "care": 0.5}';
    expect(parseClassifierResponse(missing)).toBeNull();
  });
});
