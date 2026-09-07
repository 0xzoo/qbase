/**
 * EligibilityService + PollService — wave-scoped gates.
 *
 * `check` is exercised against a stub env (KV map) so the gate order and the
 * `poll:eligible:<pollId>:<fid>` cache contract are pinned without D1. The
 * loaders (`checkById`, `checkQuestion`, `getCurrentPoll`) run against the
 * pool's local D1 with a minimal `polls` + `queries` schema.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { EligibilityService, eligibilityCacheKey } from '../../worker/services/EligibilityService';
import { getCurrentPoll, getPoll, insertPoll, isPollClosed } from '../../worker/services/PollService';

const FUTURE = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
const PAST = new Date(Date.now() - 3600 * 1000).toISOString();

function stubEnv(kv: Map<string, string> = new Map()) {
  return {
    DB: env.DB,
    KV_USER_PROFILES: {
      get: async (k: string) => kv.get(k) ?? null,
      put: async (k: string, v: string) => { kv.set(k, v); },
    },
  };
}

const nftGate = (fids: number[]) => JSON.stringify({
  type: 'nft_snapshot', contract: '0x' + 'a'.repeat(40), chain: 'base',
  snapshot_fids: fids, holder_address_count: fids.length, snapshotted_at: PAST,
});

describe('EligibilityService.check (wave-scoped)', () => {
  it('closes_at in the past → closed, regardless of gate', async () => {
    const r = await EligibilityService.check(stubEnv(), { id: 'p1', closes_at: PAST, eligibility_gate: nftGate([7]) }, 7);
    expect(r).toMatchObject({ eligible: false, reason: 'closed', closesAt: PAST, pollId: 'p1' });
  });

  it('open wave without a gate → no_gate', async () => {
    const r = await EligibilityService.check(stubEnv(), { id: 'p1', closes_at: FUTURE }, 7);
    expect(r).toMatchObject({ eligible: true, reason: 'no_gate', closesAt: FUTURE, pollId: 'p1' });
  });

  it('snapshot gate: fid in snapshot → open, else not_holder', async () => {
    const poll = { id: 'p1', closes_at: FUTURE, eligibility_gate: nftGate([7, 8]) };
    expect(await EligibilityService.check(stubEnv(), poll, 7)).toMatchObject({ eligible: true, reason: 'open' });
    expect(await EligibilityService.check(stubEnv(), poll, 9)).toMatchObject({ eligible: false, reason: 'not_holder' });
  });

  it('accepts a pre-parsed gate object as well as the raw D1 string', async () => {
    const parsed = JSON.parse(nftGate([7]));
    const r = await EligibilityService.check(stubEnv(), { id: 'p1', closes_at: FUTURE, eligibility_gate: parsed }, 7);
    expect(r.reason).toBe('open');
  });

  it('unknown gate type → unknown_gate (fail closed)', async () => {
    const gate = JSON.stringify({ type: 'something_else', snapshot_fids: [7] });
    const r = await EligibilityService.check(stubEnv(), { id: 'p1', closes_at: FUTURE, eligibility_gate: gate }, 7);
    expect(r).toMatchObject({ eligible: false, reason: 'unknown_gate' });
  });

  it('caches the snapshot lookup under poll:eligible:<pollId>:<fid>', async () => {
    const kv = new Map<string, string>();
    const poll = { id: 'wave-abc', closes_at: FUTURE, eligibility_gate: nftGate([7]) };
    await EligibilityService.check(stubEnv(kv), poll, 7);
    await EligibilityService.check(stubEnv(kv), poll, 9);
    expect(eligibilityCacheKey('wave-abc', 7)).toBe('poll:eligible:wave-abc:7');
    expect(kv.get('poll:eligible:wave-abc:7')).toBe('1');
    expect(kv.get('poll:eligible:wave-abc:9')).toBe('0');
  });

  it('a cached verdict short-circuits the snapshot lookup', async () => {
    const kv = new Map<string, string>([[eligibilityCacheKey('wave-abc', 7), '0']]);
    const poll = { id: 'wave-abc', closes_at: FUTURE, eligibility_gate: nftGate([7]) };
    const r = await EligibilityService.check(stubEnv(kv), poll, 7);
    expect(r.reason).toBe('not_holder');
  });

  it('two waves on one question do not share a cache entry', async () => {
    const kv = new Map<string, string>();
    await EligibilityService.check(stubEnv(kv), { id: 'wave-1', closes_at: FUTURE, eligibility_gate: nftGate([7]) }, 7);
    const r = await EligibilityService.check(stubEnv(kv), { id: 'wave-2', closes_at: FUTURE, eligibility_gate: nftGate([8]) }, 7);
    expect(r.reason).toBe('not_holder');
    expect(kv.get('poll:eligible:wave-1:7')).toBe('1');
    expect(kv.get('poll:eligible:wave-2:7')).toBe('0');
  });

  it('does not touch the cache when the poll has no id', async () => {
    const kv = new Map<string, string>();
    await EligibilityService.check(stubEnv(kv), { closes_at: FUTURE, eligibility_gate: nftGate([7]) }, 7);
    expect(kv.size).toBe(0);
  });
});

describe('PollService + loaders (D1)', () => {
  const Q_WAVED = 'q-waved';
  const Q_PLAIN = 'q-plain';

  beforeAll(async () => {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS queries (id TEXT PRIMARY KEY, stem TEXT, closes_at TEXT, eligibility_gate TEXT)`,
    ).run();
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS polls (
         id TEXT PRIMARY KEY, question_id TEXT NOT NULL, closes_at TEXT NOT NULL,
         eligibility_gate TEXT, options_config TEXT, author_fid INTEGER, cast_hash TEXT,
         channel_id TEXT, kind TEXT NOT NULL DEFAULT 'measure', created_at TEXT NOT NULL)`,
    ).run();
    await env.DB.prepare(`INSERT OR IGNORE INTO queries (id, stem) VALUES (?, 'waved'), (?, 'plain')`)
      .bind(Q_WAVED, Q_PLAIN).run();
  });

  it('insertPoll → getPoll round-trips with defaults', async () => {
    const created = await insertPoll(env.DB, { question_id: Q_PLAIN, closes_at: FUTURE, author_fid: 42 });
    const loaded = await getPoll(env.DB, created.id);
    expect(loaded).toMatchObject({ id: created.id, question_id: Q_PLAIN, closes_at: FUTURE, author_fid: 42, eligibility_gate: null, cast_hash: null });
    expect(await getPoll(env.DB, 'nope')).toBeNull();
    // cleanup so Q_PLAIN stays wave-less for the checkQuestion test
    await env.DB.prepare('DELETE FROM polls WHERE id = ?').bind(created.id).run();
  });

  it('getCurrentPoll returns the most recently opened wave', async () => {
    const old = await insertPoll(env.DB, { id: 'w-old', question_id: Q_WAVED, closes_at: PAST, created_at: '2026-01-01T00:00:00.000Z' });
    const recent = await insertPoll(env.DB, { id: 'w-new', question_id: Q_WAVED, closes_at: FUTURE, created_at: '2026-06-01T00:00:00.000Z' });
    const current = await getCurrentPoll(env.DB, Q_WAVED);
    expect(current?.id).toBe(recent.id);
    expect(old.id).toBe('w-old');
    expect(await getCurrentPoll(env.DB, Q_PLAIN)).toBeNull();
  });

  it('isPollClosed reads closes_at', () => {
    expect(isPollClosed({ closes_at: PAST })).toBe(true);
    expect(isPollClosed({ closes_at: FUTURE })).toBe(false);
    expect(isPollClosed({ closes_at: 'garbage' })).toBe(false);
  });

  it('checkById: missing wave → null; closed wave → closed', async () => {
    expect(await EligibilityService.checkById(stubEnv(), 'missing', 7)).toBeNull();
    const r = await EligibilityService.checkById(stubEnv(), 'w-old', 7);
    expect(r).toMatchObject({ eligible: false, reason: 'closed', pollId: 'w-old' });
  });

  it('checkQuestion: unknown question → null; no wave → no_gate; wave → its verdict', async () => {
    expect(await EligibilityService.checkQuestion(stubEnv(), 'missing-q', 7)).toBeNull();
    expect(await EligibilityService.checkQuestion(stubEnv(), Q_PLAIN, 7)).toMatchObject({ eligible: true, reason: 'no_gate', poll: null });
    const r = await EligibilityService.checkQuestion(stubEnv(), Q_WAVED, 7);
    expect(r).toMatchObject({ eligible: true, reason: 'no_gate', pollId: 'w-new' });
    expect(r?.poll?.id).toBe('w-new');
  });
});
