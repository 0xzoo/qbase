/**
 * Synthetic persona tests for the apperception scorer.
 *
 * Each persona is constructed by providing the answer pattern that maximally pushes
 * toward a target style (high/low on each of the 3 dims). We verify:
 *   - Correct style assignment
 *   - Score ordering matches the persona
 *   - Confidence bands work
 *   - Invariants: empty answers → neutral, acquiescence is mitigated by reverse-keyed items.
 */

import { describe, it, expect } from 'vitest';
import {
  scoreApperception,
  assignStyle,
  freeTierResult,
  gatedTierResult,
  type ApperceptionAnswer,
} from '../../../worker/services/apperception/scoring';
import {
  apperceptionQuestions,
  type ApperceptionAxis,
} from '../../../worker/services/apperception/questions';

const DIMS: readonly ApperceptionAxis[] = ['concrete', 'reflective', 'sequential'];

/**
 * Build answers that target a specific style defined by three poles:
 * - targetC: true = push concrete HIGH (example-first), false = push LOW (principle-first)
 * - targetR: true = push reflective HIGH, false = push LOW (active)
 * - targetS: true = push sequential HIGH, false = push LOW (integrative)
 */
function personaAnswers(
  targetC: boolean,
  targetR: boolean,
  targetS: boolean,
): ApperceptionAnswer[] {
  const targets: Record<ApperceptionAxis, boolean> = {
    concrete: targetC,
    reflective: targetR,
    sequential: targetS,
  };

  return apperceptionQuestions.map((q) => {
    if (q.type === 'likert') {
      // Find the primary dim and push toward the target
      let position = 2; // neutral default
      for (const d of DIMS) {
        const w = q.weights[d];
        if (typeof w === 'number' && w !== 0) {
          if (targets[d]) {
            // Push HIGH: positive weight → SA, negative weight (reverse-keyed) → SD
            position = w > 0 ? 4 : 0;
          } else {
            // Push LOW: positive weight → SD, negative weight → SA
            position = w > 0 ? 0 : 4;
          }
          break;
        }
      }
      return { questionId: q.id, type: 'likert', position };
    } else {
      // forced: pick the option whose weight aligns with targets
      const o0 = q.a_options[0];
      const o1 = q.a_options[1];
      let score0 = 0;
      let score1 = 0;
      for (const d of DIMS) {
        const w0 = o0.weights[d] ?? 0;
        const w1 = o1.weights[d] ?? 0;
        if (targets[d]) {
          score0 += w0;  // positive if this option pushes high
          score1 += w1;
        } else {
          score0 -= w0;  // negative if this option pushes low
          score1 -= w1;
        }
      }
      return { questionId: q.id, type: 'forced', optionIndex: score0 >= score1 ? 0 : 1 };
    }
  });
}

/** All Likert answers set to SA; forced picks option 0. Tests acquiescence mitigation. */
function alwaysAgree(): ApperceptionAnswer[] {
  return apperceptionQuestions.map((q) => {
    if (q.type === 'likert') return { questionId: q.id, type: 'likert', position: 4 };
    return { questionId: q.id, type: 'forced', optionIndex: 0 };
  });
}

/** All answers set to neutral / forced-pick-0. */
function allNeutral(): ApperceptionAnswer[] {
  return apperceptionQuestions.map((q) => {
    if (q.type === 'likert') return { questionId: q.id, type: 'likert', position: 2 };
    return { questionId: q.id, type: 'forced', optionIndex: 0 };
  });
}

// ---------- Pure persona tests ----------

const personas: Array<{
  name: string;
  targetC: boolean;
  targetR: boolean;
  targetS: boolean;
  expectedStyle: string;
}> = [
  { name: 'Architect',    targetC: true,  targetR: true,  targetS: true,  expectedStyle: 'Architect' },
  { name: 'Practitioner', targetC: true,  targetR: false, targetS: true,  expectedStyle: 'Practitioner' },
  { name: 'Cartographer', targetC: true,  targetR: true,  targetS: false, expectedStyle: 'Cartographer' },
  { name: 'Hacker',       targetC: true,  targetR: false, targetS: false, expectedStyle: 'Hacker' },
  { name: 'Theorist',     targetC: false, targetR: true,  targetS: true,  expectedStyle: 'Theorist' },
  { name: 'Sprinter',     targetC: false, targetR: false, targetS: true,  expectedStyle: 'Sprinter' },
  { name: 'Navigator',    targetC: false, targetR: true,  targetS: false, expectedStyle: 'Navigator' },
  { name: 'Builder',      targetC: false, targetR: false, targetS: false, expectedStyle: 'Builder' },
];

describe('apperception scoring — pure personas', () => {
  for (const p of personas) {
    it(p.name, () => {
      const answers = personaAnswers(p.targetC, p.targetR, p.targetS);
      const scores = scoreApperception(answers);
      const style = assignStyle(scores);

      expect(style.style).toBe(p.expectedStyle);
      expect(style.blended).toBe(false);
      expect(style.confidence).toBe('strong');

      // Verify score ordering
      if (p.targetC) expect(scores.concrete).toBeGreaterThan(0.65);
      else expect(scores.concrete).toBeLessThan(0.35);

      if (p.targetR) expect(scores.reflective).toBeGreaterThan(0.65);
      else expect(scores.reflective).toBeLessThan(0.35);

      if (p.targetS) expect(scores.sequential).toBeGreaterThan(0.65);
      else expect(scores.sequential).toBeLessThan(0.35);

      // Confidence should be high (all items scored)
      expect(scores.confidence).toBe(1);
    });
  }
});

// ---------- Invariants ----------

describe('apperception scoring — invariants', () => {
  it('empty answers → neutral all around', () => {
    const scores = scoreApperception([]);
    expect(scores.concrete).toBe(0.5);
    expect(scores.reflective).toBe(0.5);
    expect(scores.sequential).toBe(0.5);
    expect(scores.confidence).toBe(0);

    const style = assignStyle(scores);
    expect(style.blended).toBe(true);
    expect(style.confidence).toBe('mild');
  });

  it('all neutral answers → near 0.5 on all dims', () => {
    const answers = allNeutral();
    const scores = scoreApperception(answers);
    // Forced-choice items with option 0 will push some dims, but Likert neutrals
    // contribute 0, so the dims should stay near 0.5
    expect(scores.concrete).toBeGreaterThan(0.35);
    expect(scores.concrete).toBeLessThan(0.65);
    expect(scores.reflective).toBeGreaterThan(0.35);
    expect(scores.reflective).toBeLessThan(0.65);
    expect(scores.sequential).toBeGreaterThan(0.35);
    expect(scores.sequential).toBeLessThan(0.65);

    const style = assignStyle(scores);
    expect(style.blended).toBe(true);
  });

  it('acquiescence (SA everything) does not produce extreme scores', () => {
    const answers = alwaysAgree();
    const scores = scoreApperception(answers);

    // With reverse-keyed items (negative weights), SA-everything should produce
    // scores near 0.5, not near 0 or 1. Each dim has at least one reverse-keyed
    // Likert, so the net should be moderate.
    // Check that no dim hits an extreme (≥ 0.9, ≤ 0.1) from pure acquiescence.
    const extremes = DIMS.filter((d) => scores[d] > 0.9 || scores[d] < 0.1);
    expect(extremes).toHaveLength(0);
  });

  it('partial answers reduce confidence', () => {
    // Only answer first 10 questions (half the scorable items)
    const full = personaAnswers(true, true, true); // Architect
    const partial = full.slice(0, 10);
    const scores = scoreApperception(partial);
    expect(scores.confidence).toBeLessThan(1);
    expect(scores.confidence).toBeGreaterThan(0);
  });

  it('confidence = 1 when all questions answered', () => {
    const answers = personaAnswers(true, false, true); // Practitioner
    const scores = scoreApperception(answers);
    expect(scores.confidence).toBe(1);
  });
});

// ---------- Free / gated tier smoke tests ----------

describe('apperception — tier results', () => {
  it('freeTierResult returns scores, style, summary, signatures', () => {
    const answers = personaAnswers(false, true, false); // Navigator
    const result = freeTierResult(answers);
    expect(result.style.style).toBe('Navigator');
    expect(result.summary.length).toBeGreaterThan(0);
    expect(result.signatureAnswers.length).toBeLessThanOrEqual(3);
    expect(result.signatureAnswers.length).toBeGreaterThan(0);
    expect(result.scores.concrete).toBeLessThan(0.5); // Principle-first
    expect(result.scores.reflective).toBeGreaterThan(0.5); // Think-before-acting
    expect(result.scores.sequential).toBeLessThan(0.5); // Integrative
  });

  it('gatedTierResult includes allStyles and ranked dims', () => {
    const answers = personaAnswers(true, false, false); // Hacker
    const result = gatedTierResult(answers);
    expect(result.ranked).toHaveLength(3);
    expect(result.allStyles).toHaveLength(8);
    // Hacker should rank highest
    expect(result.allStyles[0].name).toBe('Hacker');
    expect(result.allStyles[0].match).toBeGreaterThan(80);
    expect(result.styleBreakdown.length).toBeGreaterThan(0);
  });
});
