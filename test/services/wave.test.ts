/**
 * WaveService + PollService — opening waves over questions.
 *
 * Validators and gate matching are pure. openWave / listPollsForQuestion /
 * getOpenPoll run against the pool's local D1 with a minimal schema.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import {
  gateParamsMatch,
  validateCloseTime,
  validateGateSubmission,
  openWave,
  MAX_WAVE_DURATION_MS,
} from '../../worker/services/WaveService';
import {
  getOpenPoll,
  getCurrentPoll,
  listPollsForQuestion,
  insertPoll,
  toPublicPoll,
} from '../../worker/services/PollService';
import { listVisibleOptions } from '../../worker/services/PollOptionsService';

const HOUR = 3600 * 1000;
const FUTURE = new Date(Date.now() + 7 * 24 * HOUR).toISOString();
const PAST = new Date(Date.now() - HOUR).toISOString();
const CONTRACT = '0x' + 'ab'.repeat(20);

describe('WaveService / validators', () => {
  it('validateCloseTime requires a future ISO time within a year', () => {
    expect(validateCloseTime(undefined)?.code).toBe('closes_at_required');
    expect(validateCloseTime('garbage')?.code).toBe('closes_at_invalid');
    expect(validateCloseTime(PAST)?.code).toBe('closes_at_past');
    expect(validateCloseTime(new Date(Date.now() + MAX_WAVE_DURATION_MS + HOUR).toISOString())?.code).toBe('closes_at_too_far');
    expect(validateCloseTime(FUTURE)).toBeNull();
  });

  it('validateGateSubmission enforces type / contract / chain / min_balance', () => {
    expect(validateGateSubmission(null)?.code).toBe('gate_invalid');
    expect(validateGateSubmission({ type: 'x', contract: CONTRACT, chain: 'base' })?.code).toBe('gate_invalid');
    expect(validateGateSubmission({ type: 'nft_snapshot', contract: '0x12', chain: 'base' })?.code).toBe('gate_invalid');
    expect(validateGateSubmission({ type: 'nft_snapshot', contract: CONTRACT, chain: 'eth' })?.code).toBe('gate_invalid');
    expect(validateGateSubmission({ type: 'token_snapshot', contract: CONTRACT, chain: 'base', min_balance: '0' })?.code).toBe('gate_invalid');
    expect(validateGateSubmission({ type: 'nft_snapshot', contract: CONTRACT, chain: 'base' })).toBeNull();
    expect(validateGateSubmission({ type: 'token_snapshot', contract: CONTRACT, chain: 'base', min_balance: '4420000' })).toBeNull();
  });

  it('gateParamsMatch is case-insensitive on contract and strict on threshold', () => {
    const nft = { type: 'nft_snapshot' as const, contract: CONTRACT, chain: 'base' as const };
    expect(gateParamsMatch(nft, { ...nft, contract: CONTRACT.toUpperCase().replace('0X', '0x') })).toBe(true);
    expect(gateParamsMatch(nft, { ...nft, contract: '0x' + 'cd'.repeat(20) })).toBe(false);
    const tok = { type: 'token_snapshot' as const, contract: CONTRACT, chain: 'base' as const, min_balance: '100' };
    expect(gateParamsMatch(tok, { ...tok })).toBe(true);
    expect(gateParamsMatch(tok, { ...tok, min_balance: '101' })).toBe(false);
    expect(gateParamsMatch(nft, tok)).toBe(false);
  });
});

describe('WaveService.openWave (D1)', () => {
  const Q_MC = 'q-mc';
  const Q_TEXT = 'q-text';

  beforeAll(async () => {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS queries (id TEXT PRIMARY KEY, stem TEXT, type TEXT, a_options TEXT)`,
    ).run();
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS polls (
         id TEXT PRIMARY KEY, question_id TEXT NOT NULL, closes_at TEXT NOT NULL,
         eligibility_gate TEXT, options_config TEXT, author_fid INTEGER, cast_hash TEXT,
         channel_id TEXT, kind TEXT NOT NULL DEFAULT 'measure', created_at TEXT NOT NULL)`,
    ).run();
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS poll_options (
         id TEXT PRIMARY KEY, q_id TEXT NOT NULL, label TEXT NOT NULL, label_norm TEXT NOT NULL,
         source TEXT NOT NULL DEFAULT 'writein', created_by_fid INTEGER, created_at TEXT NOT NULL,
         hidden INTEGER NOT NULL DEFAULT 0, UNIQUE (q_id, label_norm))`,
    ).run();
    await env.DB.prepare(
      `INSERT OR IGNORE INTO queries (id, stem, type, a_options) VALUES (?, 'mc q', 'mc', ?), (?, 'text q', 'text', NULL)`,
    ).bind(Q_MC, JSON.stringify(['yes', 'no']), Q_TEXT).run();
  });

  it('404s for an unknown question and rejects decide waves for now', async () => {
    const missing = await openWave(env, { question_id: 'nope', closes_at: FUTURE });
    expect(missing).toMatchObject({ ok: false, status: 404, code: 'question_not_found' });
    const decide = await openWave(env, { question_id: Q_MC, closes_at: FUTURE, kind: 'decide' });
    expect(decide).toMatchObject({ ok: false, status: 400, code: 'kind_unavailable' });
  });

  it('rejects options_config on non-mc questions', async () => {
    const r = await openWave(env, { question_id: Q_TEXT, closes_at: FUTURE, options_config: { open: true } });
    expect(r).toMatchObject({ ok: false, status: 400, code: 'options_config_invalid' });
  });

  it('opens a measure wave with provenance and seeds open options from a_options', async () => {
    const r = await openWave(env, {
      question_id: Q_MC, closes_at: FUTURE, options_config: { open: true, cap: 10 },
      author_fid: 42, channel_id: 'qbase',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.poll).toMatchObject({ question_id: Q_MC, kind: 'measure', author_fid: 42, channel_id: 'qbase', closes_at: FUTURE });
    expect(JSON.parse(r.poll.options_config!)).toMatchObject({ open: true, cap: 10 });
    const seeded = await listVisibleOptions(env.DB, Q_MC);
    expect(seeded.map(o => o.label)).toEqual(['yes', 'no']);
    const pub = toPublicPoll(r.poll);
    expect(pub).toMatchObject({ id: r.poll.id, is_closed: false, kind: 'measure', options_config: { open: true, cap: 10 } });
    expect(pub).not.toHaveProperty('eligibility_gate');
  });

  it('lists waves newest first and resolves the open one', async () => {
    const q = 'q-list';
    await env.DB.prepare(`INSERT OR IGNORE INTO queries (id, stem, type) VALUES (?, 's', 'text')`).bind(q).run();
    await insertPoll(env.DB, { id: 'w-closed', question_id: q, closes_at: PAST, created_at: '2026-01-01T00:00:00.000Z' });
    await insertPoll(env.DB, { id: 'w-open', question_id: q, closes_at: FUTURE, created_at: '2026-02-01T00:00:00.000Z' });
    await insertPoll(env.DB, { id: 'w-closed-2', question_id: q, closes_at: PAST, created_at: '2026-03-01T00:00:00.000Z' });
    const list = await listPollsForQuestion(env.DB, q);
    expect(list.map(p => p.id)).toEqual(['w-closed-2', 'w-open', 'w-closed']);
    expect((await getCurrentPoll(env.DB, q))?.id).toBe('w-closed-2');
    expect((await getOpenPoll(env.DB, q))?.id).toBe('w-open');
    expect(await getOpenPoll(env.DB, 'q-none')).toBeNull();
  });
});
