/**
 * Wave-scoped counting: AnswerCountService with pollId, and the vote-change
 * signal (churn + public change log). Runs against the pool's local D1 with a
 * minimal Answers schema (answer_type_id is TEXT, as in prod).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { getMcCounts, getCheckboxCounts, getScaleCounts, getExistingAnswer, getVoteChurn } from '../../worker/services/AnswerCountService';

const Q = 'q-counts';
const W1 = 'wave-1';
const W2 = 'wave-2';
const ANON_BOT = 514282;

let seq = 0;
async function answer(userId: number, value: string, opts: { type?: number; audience?: string; poll?: string | null; t?: string } = {}) {
  seq += 1;
  const created = opts.t ?? `2026-09-01T00:00:${String(seq).padStart(2, '0')}.000Z`;
  await env.DB.prepare(
    `INSERT INTO Answers (id, q_id, user_id, value, answer_type_id, audience, created_at, poll_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(`a-${seq}`, Q, userId, value, String(opts.type ?? 2), opts.audience ?? 'Public', created, opts.poll ?? null).run();
}

describe('AnswerCountService / wave scope', () => {
  beforeAll(async () => {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS Answers (
         id TEXT PRIMARY KEY, q_id TEXT NOT NULL, user_id INTEGER NOT NULL, value TEXT,
         answer_type_id TEXT, answer_data TEXT, audience TEXT, created_at TEXT, poll_id TEXT)`,
    ).run();
    // wave 1: user 1 votes A then flips to B; user 2 votes A; anon-bot rows are two different people
    await answer(1, 'A', { poll: W1 });
    await answer(1, 'B', { poll: W1 });
    await answer(2, 'A', { poll: W1 });
    await answer(ANON_BOT, 'A', { poll: W1, audience: 'Anon' });
    await answer(ANON_BOT, 'B', { poll: W1, audience: 'Anon' });
    // wave 2: user 1 votes A (a fresh dataset, no inherited stats)
    await answer(1, 'A', { poll: W2 });
    // direct answers (no wave): user 3 votes C; user 1 changes to C directly
    await answer(3, 'C', { poll: null });
    await answer(1, 'C', { poll: null });
    // checkbox + scale rows in wave 1 and direct
    await answer(4, 'x, y', { type: 4, poll: W1 });
    await answer(5, 'y', { type: 4, poll: null });
    await answer(6, '5', { type: 3, poll: W1 });
    await answer(7, '3', { type: 3, poll: null });
  });

  it('question-level MC counts every answer, latest per user across waves', async () => {
    const { counts, total } = await getMcCounts(env.DB, Q);
    // user1 → C (latest overall), user2 → A, user3 → C, anon-bot → B
    expect(counts).toEqual({ C: 2, A: 1, B: 1 });
    expect(total).toBe(4);
  });

  it('wave-level MC counts only that wave, latest per (wave, user)', async () => {
    const w1 = await getMcCounts(env.DB, Q, W1);
    expect(w1.counts).toEqual({ B: 2, A: 1 }); // user1→B, user2→A, anon-bot→B
    expect(w1.total).toBe(3);
    const w2 = await getMcCounts(env.DB, Q, W2);
    expect(w2.counts).toEqual({ A: 1 });
    expect(w2.total).toBe(1);
  });

  it('checkbox and scale readers honor the wave scope', async () => {
    expect((await getCheckboxCounts(env.DB, Q)).total).toBe(2);
    expect((await getCheckboxCounts(env.DB, Q, W1))).toEqual({ optionCounts: { x: 1, y: 1 }, total: 1 });
    expect((await getScaleCounts(env.DB, Q)).total).toBe(2);
    expect((await getScaleCounts(env.DB, Q, W1)).total).toBe(1);
    expect((await getScaleCounts(env.DB, Q, W2)).total).toBe(0);
  });

  it('getExistingAnswer is per wave when scoped', async () => {
    expect((await getExistingAnswer(env.DB, Q, 1, 2))?.value).toBe('C');
    expect((await getExistingAnswer(env.DB, Q, 1, 2, W1))?.value).toBe('B');
    expect((await getExistingAnswer(env.DB, Q, 1, 2, W2))?.value).toBe('A');
    expect(await getExistingAnswer(env.DB, Q, 2, 2, W2)).toBeNull();
  });

  it('vote churn counts identifiable flips and logs public changes only', async () => {
    const { churn, changes } = await getVoteChurn(env.DB, W1, 2, [3, ANON_BOT]);
    // user1 flipped once; anon-bot rows are excluded (different people share that id)
    expect(churn).toEqual({ changed_voters: 1, total_changes: 1 });
    expect(changes).toEqual([expect.objectContaining({ fid: 1, from: 'A', to: 'B' })]);
    const w2 = await getVoteChurn(env.DB, W2, 2, [3, ANON_BOT]);
    expect(w2.churn).toEqual({ changed_voters: 0, total_changes: 0 });
    expect(w2.changes).toEqual([]);
  });
});
