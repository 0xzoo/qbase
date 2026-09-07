/**
 * values compatibility (docs/quizzes/CONTENT-PLAN.md §7.5, card t_990220e3).
 *
 * Pure: two opposite personas split on the items that probe their dims and
 * agree nowhere they both took a side; identical profiles agree everywhere;
 * open-text answers never enter a comparison; ranking is deterministic and
 * capped at three per side; the templated narrative names both people; the
 * LLM parser insists on the counts it was promised.
 *
 * Against the pool's local D1: two sealed completions compare through the
 * sanctioned open path, names come from an injected resolver, the narrative
 * is cached in KV under the version, a non-values id is null, the latest
 * completion per person is the newest one.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
  compareProfiles,
  staticNarrative,
  parseCompareResponse,
  buildComparePrompt,
  COMPARE_VERSION,
  SURPRISING_PER_SIDE,
  type CompareProfile,
} from '../../../worker/services/values/compare';
import {
  compareCompletions,
  latestValuesCompletion,
  loadValuesProfile,
  sanitizeAnswers,
  isCompletionId,
} from '../../../worker/services/values/compareService';
import { freeTierResult, type ValuesAnswer } from '../../../worker/services/values/scoring';
import { valuesQuestions, type ValuesAxis } from '../../../worker/services/values/questions';
import { createQuizCompletion } from '../../../worker/routes/quiz-completions';

// The answer pattern that maximally raises `target` (as in scoring.test.ts),
// with an open-text answer on every open item so we can prove it never shows.
function pureAnswers(target: ValuesAxis): ValuesAnswer[] {
  const out: ValuesAnswer[] = [];
  for (const q of valuesQuestions) {
    if (q.type === 'likert') {
      const w = q.weights[target] ?? 0;
      out.push({ questionId: q.id, type: 'likert', position: w > 0 ? 4 : w < 0 ? 0 : 2 });
    } else if (q.type === 'forced') {
      const w0 = q.a_options[0].weights[target] ?? 0;
      const w1 = q.a_options[1].weights[target] ?? 0;
      out.push({ questionId: q.id, type: 'forced', optionIndex: w0 >= w1 ? 0 : 1 });
    } else {
      out.push({ questionId: q.id, type: 'open', text: `SECRET-${target}-${q.id}` });
    }
  }
  return out;
}

function profile(id: string, fid: number, answers: ValuesAnswer[]): CompareProfile {
  const r = freeTierResult(answers);
  return { completionId: id, fid, completedAt: 1, scores: r.scores, dominant: r.dominant, secondary: r.secondary, answers };
}

describe('compareProfiles', () => {
  const A = profile('a', 1, pureAnswers('autonomy'));
  const C = profile('c', 2, pureAnswers('care'));

  it('identical profiles: full overlap, every decided item agrees, no splits', () => {
    const cmp = compareProfiles(A, profile('a2', 3, pureAnswers('autonomy')));
    expect(cmp.alignment).toBe(1);
    expect(cmp.dims.every((d) => d.delta === 0)).toBe(true);
    expect(cmp.disagreeCount).toBe(0);
    expect(cmp.disagreements).toEqual([]);
    expect(cmp.agreeCount).toBeGreaterThan(0);
    expect(cmp.agreements.length).toBe(Math.min(SURPRISING_PER_SIDE, cmp.agreeCount));
    // 18 scorable items in the bank (15 likert + 3 forced); open-text excluded
    expect(cmp.sharedItems).toBe(valuesQuestions.filter((q) => q.type !== 'open').length);
  });

  it('opposite personas split where their dims are probed and the deltas carry sign', () => {
    const cmp = compareProfiles(A, C);
    const aut = cmp.dims.find((d) => d.dim === 'autonomy')!;
    const care = cmp.dims.find((d) => d.dim === 'care')!;
    expect(aut.delta).toBeGreaterThan(0);   // a − b: autonomy person higher
    expect(care.delta).toBeLessThan(0);
    expect(cmp.alignment).toBeLessThan(1);
    // A pure persona answers neutral wherever its dim is not probed, so the
    // only splits are the two items that pit autonomy against care.
    expect(cmp.disagreeCount).toBe(2);
    expect(cmp.disagreements.length).toBe(Math.min(SURPRISING_PER_SIDE, cmp.disagreeCount));
    expect(cmp.disagreements.map((i) => i.questionId).sort()).toEqual(['q_values_hard_truth', 'q_values_principles_v_peace']);
    const split = cmp.disagreements.find((i) => i.questionId === 'q_values_principles_v_peace')!;
    expect(split.a).toBe('stick with your principles');
    expect(split.b).toBe('go along to keep the peace');
    expect(cmp.neutralCount).toBeGreaterThan(0);
  });

  it('never surfaces an open-text answer', () => {
    const cmp = compareProfiles(A, C);
    const json = JSON.stringify(cmp);
    expect(json).not.toContain('SECRET-');
    expect(cmp.agreements.concat(cmp.disagreements).every((i) => i.type !== ('open' as string))).toBe(true);
  });

  it('is deterministic and sorted by surprise, ties in bank order', () => {
    const x = compareProfiles(A, C);
    const y = compareProfiles(A, C);
    expect(x).toEqual(y);
    for (const list of [x.agreements, x.disagreements]) {
      for (let i = 1; i < list.length; i++) expect(list[i - 1].surprise).toBeGreaterThanOrEqual(list[i].surprise);
    }
  });

  it('a fence-sitter counts as neutral, not as agreement or disagreement', () => {
    const q = valuesQuestions.find((q) => q.type === 'likert')!;
    const a = profile('a', 1, [{ questionId: q.id, type: 'likert', position: 4 }]);
    const b = profile('b', 2, [{ questionId: q.id, type: 'likert', position: 2 }]);
    const cmp = compareProfiles(a, b);
    expect(cmp.sharedItems).toBe(1);
    expect(cmp.neutralCount).toBe(1);
    expect(cmp.agreeCount + cmp.disagreeCount).toBe(0);
  });

  it('only items both people answered are shared; the latest answer to a repeated item wins', () => {
    const q = valuesQuestions.find((q) => q.type === 'likert')!;
    const a = profile('a', 1, [
      { questionId: q.id, type: 'likert', position: 0 },
      { questionId: q.id, type: 'likert', position: 4 },
    ]);
    const b = profile('b', 2, [{ questionId: q.id, type: 'likert', position: 3 }]);
    const cmp = compareProfiles(a, b);
    expect(cmp.sharedItems).toBe(1);
    expect(cmp.agreeCount).toBe(1);
    expect(cmp.agreements[0].a).toBe('strongly agree');
  });
});

describe('narrative', () => {
  const A = profile('a', 1, pureAnswers('autonomy'));
  const C = profile('c', 2, pureAnswers('care'));
  const names = { a: '@alice', b: '@carol' };

  it('the templated fallback names both people and covers every chosen item', () => {
    const cmp = compareProfiles(A, C);
    const n = staticNarrative(cmp, names);
    expect(n.headline).toContain('@alice');
    expect(n.headline).toContain('@carol');
    expect(n.agreements.length).toBe(cmp.agreements.length);
    expect(n.disagreements.length).toBe(cmp.disagreements.length);
    expect(n.disagreements[0]).toContain('@alice');
  });

  it('the prompt carries the names, every chosen item and no open text', () => {
    const cmp = compareProfiles(A, C);
    const p = buildComparePrompt(cmp, names);
    expect(p).toContain('@alice');
    for (const it of cmp.agreements.concat(cmp.disagreements)) expect(p).toContain(it.stem);
    expect(p).not.toContain('SECRET-');
    expect(p).toContain(`exactly ${cmp.disagreements.length} strings`);
  });

  it('parses a JSON reply, tolerates prose around it, and refuses short lists', () => {
    const good = { headline: 'h', agreements: ['x', 'y', 'z'], disagreements: ['p', 'q', 'r'] };
    expect(parseCompareResponse(`sure:\n${JSON.stringify(good)}\nthanks`, { agreements: 3, disagreements: 3 })).toEqual(good);
    expect(parseCompareResponse(JSON.stringify({ ...good, agreements: ['x'] }), { agreements: 3, disagreements: 3 })).toBeNull();
    expect(parseCompareResponse(JSON.stringify({ ...good, headline: '' }), { agreements: 3, disagreements: 3 })).toBeNull();
    expect(parseCompareResponse('nope', { agreements: 0, disagreements: 0 })).toBeNull();
    // extra strings are trimmed to the promised count
    const long = parseCompareResponse(JSON.stringify({ ...good, agreements: ['x', 'y', 'z', 'w'] }), { agreements: 3, disagreements: 3 });
    expect(long?.agreements).toEqual(['x', 'y', 'z']);
  });
});

describe('sanitizeAnswers / isCompletionId', () => {
  it('keeps well-formed answers to known items only', () => {
    const q = valuesQuestions[0];
    const out = sanitizeAnswers([
      { questionId: q.id, type: 'likert', position: 3 },
      { questionId: 'q_values_nope', type: 'likert', position: 3 },
      { questionId: q.id, type: 'forced', optionIndex: 2 },
      { questionId: q.id, type: 'open', text: 'hi' },
      'junk', null, 7,
    ]);
    expect(out).toEqual([
      { questionId: q.id, type: 'likert', position: 3 },
      { questionId: q.id, type: 'open', text: 'hi' },
    ]);
    expect(sanitizeAnswers('nope')).toEqual([]);
  });

  it('accepts a UUID and nothing else', () => {
    expect(isCompletionId(crypto.randomUUID())).toBe(true);
    expect(isCompletionId('abc')).toBe(false);
    expect(isCompletionId("' OR 1=1")).toBe(false);
  });
});

describe('compareCompletions against D1', () => {
  const K1 = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
  const testEnv = () => ({ DB: env.DB, ANSWER_KEKS: K1, ANON_FID: '514282', VALUES_SESSIONS: env.VALUES_SESSIONS });
  const users = async (fids: number[]) => fids.map((fid) => ({ fid, username: `u${fid}`, display_name: `User ${fid}`, pfp_url: null as unknown as string }));

  beforeAll(async () => {
    await env.DB.exec(
      "CREATE TABLE IF NOT EXISTS quiz_completions (id TEXT PRIMARY KEY, quiz_id TEXT NOT NULL, user_id INTEGER NOT NULL, completed_at INTEGER NOT NULL, answers_encrypted TEXT, answers_snapshot TEXT, scores TEXT, result_category TEXT, visibility TEXT NOT NULL DEFAULT 'private', created_at INTEGER NOT NULL, answers_materialized_at TEXT)"
    );
  });
  beforeEach(async () => {
    await env.DB.exec('DELETE FROM quiz_completions');
  });

  async function seed(fid: number, target: ValuesAxis): Promise<string> {
    const answers = pureAnswers(target);
    const free = freeTierResult(answers);
    return createQuizCompletion(testEnv(), {
      quizId: 'values', userId: fid, answersJson: JSON.stringify(answers),
      scores: { ...free.scores, dominant: free.dominant, secondary: free.secondary },
      resultCategory: free.dominant, format: 'quiz',
    });
  }

  it('opens two sealed completions, names both people, marks the viewer, caches the narrative', async () => {
    const idA = await seed(11, 'autonomy');
    const idB = await seed(22, 'care');
    let calls = 0;
    const generate = async () => { calls++; return { narrative: { headline: 'llm says', agreements: ['a', 'a', 'a'], disagreements: ['d', 'd', 'd'] } }; };

    const r = await compareCompletions(testEnv(), idA, idB, { viewerFid: 22, resolveUsers: users, generate });
    expect(r).not.toBeNull();
    expect(r!.status).toBe('ok');
    expect(r!.version).toBe(COMPARE_VERSION);
    expect(r!.a.username).toBe('u11');
    expect(r!.b.username).toBe('u22');
    expect(r!.a.dominant).toBe('autonomy');
    expect(r!.b.dominant).toBe('care');
    expect(r!.viewer).toBe('b');
    expect(r!.narrativeSource).toBe('llm');
    expect(r!.narrative.headline).toBe('llm says');
    expect(r!.comparison.disagreeCount).toBeGreaterThan(0);
    expect(JSON.stringify(r)).not.toContain('SECRET-');

    // second call: cached, generator not called again; a stranger is no viewer
    const again = await compareCompletions(testEnv(), idA, idB, { viewerFid: 33, resolveUsers: users, generate });
    expect(calls).toBe(1);
    expect(again!.viewer).toBeNull();
    expect(again!.narrative.headline).toBe('llm says');
  });

  it('falls back to the templated narrative when the model fails, and does not pin it for long', async () => {
    const idA = await seed(11, 'autonomy');
    const idB = await seed(22, 'openness');
    const generate = async () => ({ narrative: null, error: 'boom' });
    const r = await compareCompletions(testEnv(), idA, idB, { resolveUsers: users, generate });
    expect(r!.narrativeSource).toBe('static');
    expect(r!.narrativeError).toBe('boom');
    expect(r!.narrative.headline).toContain('@u11');
    expect(r!.narrative.disagreements.length).toBe(r!.comparison.disagreements.length);
  });

  it('is null for an unknown id or a completion of another quiz', async () => {
    const idA = await seed(11, 'autonomy');
    const other = await createQuizCompletion(testEnv(), {
      quizId: 'bartlet', userId: 22, answersJson: '[]', scores: {}, resultCategory: 'EXPLORER', format: 'quiz',
    });
    expect(await compareCompletions(testEnv(), idA, crypto.randomUUID(), { resolveUsers: users })).toBeNull();
    expect(await compareCompletions(testEnv(), idA, other, { resolveUsers: users })).toBeNull();
    expect(await loadValuesProfile(testEnv(), other)).toBeNull();
  });

  it('the latest completion per person is the newest one', async () => {
    expect(await latestValuesCompletion(testEnv(), 11)).toBeNull();
    const first = await seed(11, 'autonomy');
    await env.DB.prepare('UPDATE quiz_completions SET completed_at = completed_at - 1000 WHERE id = ?').bind(first).run();
    const second = await seed(11, 'care');
    const latest = await latestValuesCompletion(testEnv(), 11);
    expect(latest?.id).toBe(second);
    expect(latest?.dominant).toBe('care');
  });
});
