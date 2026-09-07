/**
 * quiz-completions — sealed completion snapshots (docs/specs/private-answer-encryption.md §7.5).
 *
 * Against the pool's local D1: every completion is private and attributed to
 * the taker, with a sealed `answers_encrypted` and a NULL snapshot (the
 * public / anon / allowlist options went 2026-09-08 — the per-item rows decide
 * who sees what, docs/specs/quiz-answer-audience.md §2.2);
 * `readCompletionAnswers` opens sealed and legacy rows; `completionSummary`
 * names the completion a result page mounts the chooser for; no key →
 * nothing written.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
  createQuizCompletion, readCompletionAnswers, completionSummary, completionCtx, type CompletionRow,
} from '../../worker/routes/quiz-completions';
import { SecretNotReadyError } from '../../worker/services/secret/SecretBox';

const K1 = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const testEnv = { DB: env.DB, ANSWER_KEKS: K1, ANON_FID: '514282' };

const ANSWERS = [
  { queryId: 'q1', optionIndex: 2 },
  { queryId: 'q2', optionIndex: 0, text: 'I would rather be respected than liked' },
];

async function row(id: string): Promise<CompletionRow> {
  return (await env.DB.prepare('SELECT * FROM quiz_completions WHERE id = ?').bind(id).first()) as CompletionRow;
}

describe('quiz completions — sealed answers', () => {
  beforeAll(async () => {
    await env.DB.exec(
      'CREATE TABLE IF NOT EXISTS quiz_completions (id TEXT PRIMARY KEY, quiz_id TEXT NOT NULL, user_id INTEGER NOT NULL, completed_at INTEGER NOT NULL, answers_encrypted TEXT, answers_snapshot TEXT, scores TEXT, result_category TEXT, visibility TEXT NOT NULL DEFAULT \'private\', created_at INTEGER NOT NULL, answers_materialized_at TEXT)'
    );
  });
  beforeEach(async () => {
    await env.DB.exec('DELETE FROM quiz_completions');
  });

  it('a private completion is sealed in D1 with no plaintext and a NULL snapshot', async () => {
    const id = await createQuizCompletion(testEnv, {
      quizId: 'values', userId: 42, answersJson: JSON.stringify(ANSWERS),
      scores: { care: 3 }, resultCategory: 'care',
    });
    const r = await row(id);
    expect(r.visibility).toBe('private');
    expect(r.answers_snapshot).toBeNull();
    expect(r.answers_encrypted!.startsWith('{"qenc":1')).toBe(true);
    expect(r.answers_encrypted).not.toContain('respected');
    expect(r.answers_encrypted).not.toContain('optionIndex');
    expect(JSON.parse(r.answers_encrypted!).ctx).toBe(completionCtx(id, 'private', 42));
    // scores stay plaintext by design
    expect(JSON.parse(r.scores as string)).toEqual({ care: 3 });
    expect(await readCompletionAnswers(testEnv, r)).toEqual(ANSWERS);
  });

  it('a sealed row is bound to its owner: a re-pointed user_id does not open', async () => {
    const id = await createQuizCompletion(testEnv, {
      quizId: 'values', userId: 42, answersJson: JSON.stringify(ANSWERS), scores: {}, resultCategory: 'x',
    });
    await env.DB.prepare('UPDATE quiz_completions SET user_id = 43 WHERE id = ?').bind(id).run();
    await expect(readCompletionAnswers(testEnv, await row(id))).rejects.toThrow(/context mismatch/);
  });

  it('legacy rows (plaintext snapshot, private) still read', async () => {
    await env.DB.prepare(
      "INSERT INTO quiz_completions (id, quiz_id, user_id, completed_at, answers_encrypted, answers_snapshot, scores, result_category, visibility, created_at) VALUES ('legacy', 'bartlet', 42, 1, NULL, ?, '{}', 'x', 'private', 1)"
    ).bind(JSON.stringify(ANSWERS)).run();
    expect(await readCompletionAnswers(testEnv, await row('legacy'))).toEqual(ANSWERS);
    expect(await readCompletionAnswers(testEnv, { id: 'none', user_id: 1, visibility: 'private' })).toBeNull();
  });

  it('completionSummary: the recorded completion, else the latest of the quiz, else null', async () => {
    const older = await createQuizCompletion(testEnv, {
      quizId: 'values', userId: 42, answersJson: JSON.stringify(ANSWERS), scores: {}, resultCategory: 'x',
    });
    await env.DB.prepare('UPDATE quiz_completions SET completed_at = 1, answers_materialized_at = NULL WHERE id = ?').bind(older).run();
    const newer = await createQuizCompletion(testEnv, {
      quizId: 'values', userId: 42, answersJson: JSON.stringify(ANSWERS), scores: {}, resultCategory: 'x',
    });
    // nothing in ANSWERS maps to a values item, so the writer marks the completion looked-at (materialised, 0 rows)
    expect(await completionSummary(testEnv, 'values', 42, older)).toEqual({ id: older, materialized: false });
    expect(await completionSummary(testEnv, 'values', 42, newer)).toEqual({ id: newer, materialized: true });
    expect(await completionSummary(testEnv, 'values', 42, null)).toEqual({ id: newer, materialized: true });
    expect(await completionSummary(testEnv, 'values', 42, 'gone')).toEqual({ id: newer, materialized: true });
    expect(await completionSummary(testEnv, 'values', 43, older)).toBeNull(); // not theirs, and none of their own
    expect(await completionSummary(testEnv, 'bartlet', 42, null)).toBeNull();
  });

  it('with no key configured a non-public completion is not written at all', async () => {
    await expect(createQuizCompletion({ DB: env.DB }, {
      quizId: 'values', userId: 42, answersJson: JSON.stringify(ANSWERS), scores: {}, resultCategory: 'x',
    })).rejects.toBeInstanceOf(SecretNotReadyError);
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM quiz_completions').first() as { n: number };
    expect(n.n).toBe(0);
  });
});
