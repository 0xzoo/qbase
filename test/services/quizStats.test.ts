/**
 * Correlation report (docs/quizzes/CONTENT-PLAN.md §7.9; card t_589c4f56).
 *
 * Pure: Likert collapses to three buckets and text is not counted; a skewed
 * fixture yields findings with the expected lift in both directions; groups
 * below the support floor and cells that would name "all" or "none" of a
 * group are suppressed; the personal report keeps only findings whose
 * condition the person meets and says whether they answered the other side.
 */

import { describe, it, expect } from 'vitest';
import { bucketOf, vectorOf, buildStats, personalReport, type AnswerVector } from '../../worker/services/quiz/QuizStatsService';
import { valuesQuestions } from '../../worker/services/values/questions';
import { bartletQuestions } from '../../worker/services/bartlet/questions';

const V_LIKERT = valuesQuestions.find((q) => q.type === 'likert')!;
const V_FORCED = valuesQuestions.find((q) => q.type === 'forced')!;
const V_OPEN = valuesQuestions.find((q) => q.type === 'open')!;
const B0 = bartletQuestions[0];

const A = `values:${V_FORCED.id}`;
const B = `values:${V_LIKERT.id}`;
const C = `values:${valuesQuestions.filter((q) => q.type === 'likert')[1].id}`;
const D = `bartlet:${B0.id}`;

/**
 * 60 people. A ∈ {yes, no} × 30 each. Among yes: 25 agree / 5 disagree on B;
 * among no: 5 agree / 25 disagree. Base rate of agree = 0.5, so
 * P(agree | yes) = 0.833 → lift 1.667; P(disagree | yes) = 0.167 → lift 0.333.
 * C: every yes-person says 'agree' (a cell with no complement → suppressed);
 * no-people split 15/15. D: answered by 8 people only (below minGroup).
 */
function fixture(): AnswerVector[] {
  const out: AnswerVector[] = [];
  for (let i = 0; i < 30; i++) {
    out.push({ [A]: 'yes', [B]: i < 25 ? 'agree' : 'disagree', [C]: 'agree' });
  }
  for (let i = 0; i < 30; i++) {
    out.push({ [A]: 'no', [B]: i < 5 ? 'agree' : 'disagree', [C]: i < 15 ? 'agree' : 'disagree' });
  }
  for (let i = 0; i < 8; i++) out[i][D] = 'the tech';
  return out;
}

describe('quiz stats', () => {
  it('bucketOf collapses Likert to three buckets, keeps mc labels, drops text', () => {
    expect(bucketOf('values', { questionId: V_LIKERT.id, type: 'likert', position: 0 })).toEqual({ key: B, bucket: 'disagree' });
    expect(bucketOf('values', { questionId: V_LIKERT.id, type: 'likert', position: 1 })).toEqual({ key: B, bucket: 'disagree' });
    expect(bucketOf('values', { questionId: V_LIKERT.id, type: 'likert', position: 2 })).toEqual({ key: B, bucket: 'neutral' });
    expect(bucketOf('values', { questionId: V_LIKERT.id, type: 'likert', position: 4 })).toEqual({ key: B, bucket: 'agree' });
    expect(bucketOf('values', { questionId: V_FORCED.id, type: 'forced', optionIndex: 1 })).toEqual({ key: A, bucket: V_FORCED.a_options[1].label });
    expect(bucketOf('values', { questionId: V_OPEN.id, type: 'open', text: 'anything' })).toBeNull();
    expect(bucketOf('bartlet', { queryId: B0.id, optionIndex: 0 })).toEqual({ key: D, bucket: B0.a_options[0].label });
    expect(bucketOf('bartlet', { queryId: 'nope', optionIndex: 0 })).toBeNull();
    expect(vectorOf('values', [
      { questionId: V_LIKERT.id, type: 'likert', position: 0 },
      { questionId: V_LIKERT.id, type: 'likert', position: 4 }, // repeat: later wins
      { questionId: V_OPEN.id, type: 'open', text: 'x' },
    ])).toEqual({ [B]: 'agree' });
  });

  it('buildStats finds the skewed pair in both directions with the expected lift', () => {
    const stats = buildStats(fixture(), undefined, '2026-09-08T00:00:00.000Z');
    expect(stats.users).toBe(60);
    expect(stats.users_per_quiz).toEqual({ values: 60, bartlet: 8 });
    expect(stats.items[A]).toEqual({ n: 60, buckets: { yes: 30, no: 30 } });
    expect(stats.items[B]).toEqual({ n: 60, buckets: { agree: 30, disagree: 30 } });

    const f = (xk: string, xb: string, yk: string, yb: string) =>
      stats.findings.find((x) => x.x.key === xk && x.x.bucket === xb && x.y.key === yk && x.y.bucket === yb);

    expect(f(A, 'yes', B, 'agree')).toMatchObject({ n: 60, n_x: 30, n_xy: 25, p_y: 0.5, p_y_given_x: 0.833, lift: 1.667 });
    expect(f(A, 'yes', B, 'disagree')).toMatchObject({ n_x: 30, n_xy: 5, lift: 0.333 });
    expect(f(A, 'no', B, 'disagree')).toMatchObject({ lift: 1.667 });
    // the reverse direction is its own claim
    expect(f(B, 'agree', A, 'yes')).toMatchObject({ n_x: 30, n_xy: 25, lift: 1.667 });
    // strongest first
    expect(Math.abs(Math.log(stats.findings[0].lift))).toBeGreaterThanOrEqual(Math.abs(Math.log(stats.findings[stats.findings.length - 1].lift)));
  });

  it('suppresses groups below minGroup and cells that would name all or none of a group', () => {
    const stats = buildStats(fixture());
    // C given A = yes is 30 of 30 → no complement → suppressed
    expect(stats.findings.filter((x) => x.x.key === A && x.x.bucket === 'yes' && x.y.key === C)).toEqual([]);
    // D is answered by 8 people → nothing involving D
    expect(stats.findings.filter((x) => x.x.key === D || x.y.key === D)).toEqual([]);
    // every surviving cell has support on both sides
    for (const x of stats.findings) {
      expect(x.n_x).toBeGreaterThanOrEqual(10);
      expect(x.n_xy).toBeGreaterThanOrEqual(5);
      expect(x.n_x - x.n_xy).toBeGreaterThanOrEqual(5);
      expect(x.lift >= 1.5 - 1e-3 || x.lift <= 1 / 1.5 + 1e-3).toBe(true); // stored lifts are rounded
    }
  });

  it('personalReport keeps findings whose condition the person meets, one per pair, and says where they stand on the other side', () => {
    const stats = buildStats(fixture());
    const r1 = personalReport(stats, { [A]: 'yes' });
    expect(r1.my_items).toBe(1);
    expect(r1.lines.length).toBeGreaterThan(0);
    for (const l of r1.lines) {
      expect(l.x.q_id).toBe(V_FORCED.id);
      expect(l.x.bucket).toBe('yes');
      expect(l.x.stem).toBe(V_FORCED.stem);
      expect(l.you).toBe('none');
    }
    // one line per (X, Y) pair: the "more likely" claim about B, not both agree and disagree
    expect(r1.lines.filter((l) => l.y.q_id === V_LIKERT.id)).toHaveLength(1);
    expect(r1.lines[0]).toMatchObject({ y: { q_id: V_LIKERT.id, bucket: 'agree' }, lift: 1.667, share: 0.833, base: 0.5, n_x: 30, n_xy: 25 });

    const r2 = personalReport(stats, { [A]: 'yes', [B]: 'agree' });
    expect(r2.lines.find((l) => l.y.q_id === V_LIKERT.id)!.you).toBe('same');
    expect(r2.lines.find((l) => l.x.q_id === V_LIKERT.id && l.y.q_id === V_FORCED.id)!.you).toBe('same');

    const r3 = personalReport(stats, { [A]: 'no', [B]: 'agree' });
    expect(r3.lines.find((l) => l.x.q_id === V_FORCED.id && l.y.q_id === V_LIKERT.id)).toMatchObject({ y: { bucket: 'disagree' }, you: 'different' });

    expect(personalReport(stats, {}).lines).toEqual([]);
    expect(personalReport(stats, { [A]: 'yes' }, 1).lines).toHaveLength(1);
  });
});
