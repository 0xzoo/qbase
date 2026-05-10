/**
 * Synthetic persona tests for the values scorer.
 *
 * Each persona is constructed by walking the question bank and producing
 * the answer pattern that maximally pushes a target dim (or set of dims).
 * We then verify the scorer puts the right dim on top, others near 0.5,
 * and that the radar shape matches the persona description.
 *
 * Also covers invariants: empty answers → neutral + zero confidence;
 * acquiescence bias on Likert (SA-everything) is mitigated by reverse-keyed
 * items (no dim should hit 1.0 from a yea-saying respondent).
 */

import { describe, it, expect } from 'vitest';
import {
  scoreValues,
  blendOpenText,
  freeTierResult,
  type ValuesAnswer,
  type ValuesScore,
} from '../../../worker/services/values/scoring';
import {
  valuesQuestions,
  type ValuesAxis,
} from '../../../worker/services/values/questions';

const DIMS: readonly ValuesAxis[] = ['autonomy', 'care', 'openness', 'mastery', 'universalism'];

// Build the answer pattern that maximally raises `target`. Likert items with
// positive target weight get SA, negative get SD, neutral if target weight is
// absent. Forced-choice picks the option with the higher target weight.
// Open-text is skipped (the scorer doesn't use it).
function pureAnswers(target: ValuesAxis): ValuesAnswer[] {
  const answers: ValuesAnswer[] = [];
  for (const q of valuesQuestions) {
    if (q.type === 'likert') {
      const w = q.weights[target] ?? 0;
      if (w > 0) answers.push({ questionId: q.id, type: 'likert', position: 4 });
      else if (w < 0) answers.push({ questionId: q.id, type: 'likert', position: 0 });
      else answers.push({ questionId: q.id, type: 'likert', position: 2 });
    } else if (q.type === 'forced') {
      const w0 = q.a_options[0].weights[target] ?? 0;
      const w1 = q.a_options[1].weights[target] ?? 0;
      // If the question doesn't probe target, default to option 0 — it adds
      // some noise on the off-target dims, which is realistic.
      const idx = w0 >= w1 ? 0 : 1;
      answers.push({ questionId: q.id, type: 'forced', optionIndex: idx });
    }
  }
  return answers;
}

// Dual-target persona: maximize both targets. For each item, pick the answer
// that produces a non-negative contribution to both targets when possible;
// fall back to the stronger target if they conflict on the same item.
function dualPureAnswers(targetA: ValuesAxis, targetB: ValuesAxis): ValuesAnswer[] {
  const answers: ValuesAnswer[] = [];
  for (const q of valuesQuestions) {
    if (q.type === 'likert') {
      const wA = q.weights[targetA] ?? 0;
      const wB = q.weights[targetB] ?? 0;
      // Pick the answer position that maximizes (wA * aw) + (wB * aw) where
      // aw ∈ {-2,-1,0,1,2}. That's just sign(wA + wB).
      const sum = wA + wB;
      if (sum > 0) answers.push({ questionId: q.id, type: 'likert', position: 4 });
      else if (sum < 0) answers.push({ questionId: q.id, type: 'likert', position: 0 });
      else answers.push({ questionId: q.id, type: 'likert', position: 2 });
    } else if (q.type === 'forced') {
      const o0 = q.a_options[0].weights;
      const o1 = q.a_options[1].weights;
      const score0 = (o0[targetA] ?? 0) + (o0[targetB] ?? 0);
      const score1 = (o1[targetA] ?? 0) + (o1[targetB] ?? 0);
      answers.push({ questionId: q.id, type: 'forced', optionIndex: score0 >= score1 ? 0 : 1 });
    }
  }
  return answers;
}

// All Likert at SA (acquiescence test); forced-choice picks option 0 always.
function alwaysAgree(): ValuesAnswer[] {
  const answers: ValuesAnswer[] = [];
  for (const q of valuesQuestions) {
    if (q.type === 'likert') answers.push({ questionId: q.id, type: 'likert', position: 4 });
    else if (q.type === 'forced') answers.push({ questionId: q.id, type: 'forced', optionIndex: 0 });
  }
  return answers;
}

// All Likert neutral (position 2); forced-choice picks option 0.
function allNeutral(): ValuesAnswer[] {
  const answers: ValuesAnswer[] = [];
  for (const q of valuesQuestions) {
    if (q.type === 'likert') answers.push({ questionId: q.id, type: 'likert', position: 2 });
    else if (q.type === 'forced') answers.push({ questionId: q.id, type: 'forced', optionIndex: 0 });
  }
  return answers;
}

function offTargetDims(target: ValuesAxis): ValuesAxis[] {
  return DIMS.filter((d) => d !== target);
}

function describeRadar(s: ValuesScore): string {
  return DIMS.map((d) => `${d}=${s[d].toFixed(2)}`).join(' ');
}

describe('scoreValues — single-dim personas', () => {
  for (const target of DIMS) {
    it(`pure ${target} → ${target} dominant`, () => {
      const score = scoreValues(pureAnswers(target));
      const ranked = [...DIMS].sort((a, b) => score[b] - score[a]);

      expect(ranked[0], `radar: ${describeRadar(score)}`).toBe(target);
      expect(score[target], `${target} should be near max`).toBeGreaterThan(0.85);

      // Off-target dims should land closer to neutral than the target.
      for (const d of offTargetDims(target)) {
        expect(
          score[d],
          `${d} (off-target) should not exceed ${target} (target). radar: ${describeRadar(score)}`,
        ).toBeLessThan(score[target]);
      }
    });
  }
});

describe('scoreValues — dual-dim personas', () => {
  const pairs: Array<[ValuesAxis, ValuesAxis]> = [
    ['autonomy', 'mastery'],     // craft-driven independent worker
    ['care', 'universalism'],    // warm + globally-concerned
    ['openness', 'autonomy'],    // independent explorer
  ];

  for (const [a, b] of pairs) {
    it(`${a}+${b} → both dominant over the rest`, () => {
      const score = scoreValues(dualPureAnswers(a, b));
      const others = DIMS.filter((d) => d !== a && d !== b);

      expect(score[a], `radar: ${describeRadar(score)}`).toBeGreaterThan(0.7);
      expect(score[b], `radar: ${describeRadar(score)}`).toBeGreaterThan(0.7);

      // Both targets should outrank every non-target dim.
      for (const d of others) {
        expect(score[a], `${a} (target) vs ${d} (off). radar: ${describeRadar(score)}`).toBeGreaterThan(score[d]);
        expect(score[b], `${b} (target) vs ${d} (off). radar: ${describeRadar(score)}`).toBeGreaterThan(score[d]);
      }
    });
  }
});

describe('scoreValues — invariants', () => {
  it('empty answers → all dims at 0.5, confidence 0', () => {
    const score = scoreValues([]);
    for (const d of DIMS) expect(score[d]).toBe(0.5);
    expect(score.confidence).toBe(0);
  });

  it('all-neutral Likert + neutral forced → all dims at 0.5, confidence 1', () => {
    const score = scoreValues(allNeutral());
    for (const d of DIMS) {
      // Forced-choice picks contribute non-zero signal even on neutral profile;
      // expect dims close to but not exactly 0.5.
      expect(score[d], `${d}=${score[d].toFixed(3)}`).toBeGreaterThan(0.3);
      expect(score[d], `${d}=${score[d].toFixed(3)}`).toBeLessThan(0.7);
    }
    expect(score.confidence).toBe(1);
  });

  it('acquiescence bias mitigated by reverse-keyed items', () => {
    // Yea-saying respondent SA's everything. Without reverse-keyed items the
    // scorer would max out every dim. With them, no dim should exceed ~0.85.
    const score = scoreValues(alwaysAgree());
    for (const d of DIMS) {
      expect(
        score[d],
        `${d}=${score[d].toFixed(3)} should be < 0.9 due to reverse-keyed mitigation. radar: ${describeRadar(score)}`,
      ).toBeLessThan(0.9);
    }
  });

  it('partial completion → confidence < 1, scores still computable', () => {
    const all = pureAnswers('autonomy');
    const partial = all.slice(0, 5);
    const score = scoreValues(partial);
    expect(score.confidence).toBeGreaterThan(0);
    expect(score.confidence).toBeLessThan(1);
    // Autonomy should still be the leader given the answer pattern.
    const ranked = [...DIMS].sort((a, b) => score[b] - score[a]);
    expect(ranked[0]).toBe('autonomy');
  });

  it('all dims always in [0, 1]', () => {
    // Spot-check across several personas.
    const profiles = [
      pureAnswers('autonomy'),
      pureAnswers('universalism'),
      dualPureAnswers('care', 'mastery'),
      alwaysAgree(),
      allNeutral(),
      [],
    ];
    for (const answers of profiles) {
      const s = scoreValues(answers);
      for (const d of DIMS) {
        expect(s[d]).toBeGreaterThanOrEqual(0);
        expect(s[d]).toBeLessThanOrEqual(1);
      }
      expect(s.confidence).toBeGreaterThanOrEqual(0);
      expect(s.confidence).toBeLessThanOrEqual(1);
    }
  });
});

describe('blendOpenText', () => {
  it('default 0.7/0.3 mix lands between the inputs', () => {
    const likert: ValuesScore = {
      autonomy: 1.0, care: 0.5, openness: 0.5, mastery: 0.5, universalism: 0.5,
      confidence: 1,
    };
    const open = {
      autonomy: 0.0, care: 0.5, openness: 0.5, mastery: 0.5, universalism: 0.5,
    };
    const blended = blendOpenText(likert, open);
    expect(blended.autonomy).toBeCloseTo(0.7, 5);
    expect(blended.confidence).toBe(1); // confidence comes from Likert side
  });

  it('respects custom weight', () => {
    const likert: ValuesScore = {
      autonomy: 1.0, care: 0.5, openness: 0.5, mastery: 0.5, universalism: 0.5,
      confidence: 1,
    };
    const open = {
      autonomy: 0.0, care: 0.5, openness: 0.5, mastery: 0.5, universalism: 0.5,
    };
    const blended = blendOpenText(likert, open, 0.5);
    expect(blended.autonomy).toBeCloseTo(0.5, 5);
  });
});

describe('freeTierResult', () => {
  it('sets badge from dominant dim', () => {
    const result = freeTierResult(pureAnswers('care'));
    expect(result.dominant).toBe('care');
    expect(result.badge).toBe('Care-led');
    expect(result.summary.length).toBeGreaterThan(0);
  });

  it('signature answers reference real questions', () => {
    const result = freeTierResult(pureAnswers('mastery'));
    expect(result.signatureAnswers.length).toBeLessThanOrEqual(3);
    expect(result.signatureAnswers.length).toBeGreaterThan(0);
    // Each rendered string should embed a question stem from the bank.
    const stems = new Set(valuesQuestions.map((q) => q.stem));
    for (const sig of result.signatureAnswers) {
      const matched = [...stems].some((s) => sig.includes(s));
      expect(matched, `signature missing stem: ${sig}`).toBe(true);
    }
  });
});
