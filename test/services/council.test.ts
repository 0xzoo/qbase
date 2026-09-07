/**
 * CouncilService — summon flow (docs/specs/paid-council.md).
 *
 * Runs against the pool's local D1 with the council tables plus minimal
 * queries / question_meta / farcaster_casts. The escrow, the oracle Durable
 * Object and the rate limiter are injected, so the tests pin: the free gate,
 * stake_required with no model call, deduction after answers only, "already
 * answered" costing nothing, cast-hash replay, all-models-failed → no charge,
 * the web double-click lock, and paid re-asks (a new round per summon).
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { parseUnits } from 'viem';
import { councilConfig, summon, listResponses, questionIdForCast, viewerStake } from '../../worker/services/CouncilService';
import type { CouncilDeps } from '../../worker/services/CouncilService';
import type { OracleDispatchRequest, OracleDispatchResult } from '../../worker/agents/OracleAgent';

const Q_CAST = 'q-cast';        // question with a cast (question_meta)
const Q_OLD = 'q-old';          // question with a cast only in farcaster_casts
const Q_WEB = 'q-web';          // question never cast
const CAST_HASH = '0x' + 'aa'.repeat(20);
const OLD_HASH = '0x' + 'bb'.repeat(20);

function kvStub() {
  const store = new Map<string, string>();
  return {
    store,
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => { store.set(k, v); },
    delete: async (k: string) => { store.delete(k); },
  };
}

function testEnv(vars: Record<string, string> = {}) {
  return { DB: env.DB, KV_FRAME_NOTIFICATIONS: kvStub(), ...vars };
}

function escrowStub(balanceWei: bigint) {
  const deductions: Array<{ fid: number; amount: bigint }> = [];
  return {
    deductions,
    balance: balanceWei,
    availableBalance: async function () { return this.balance; },
    recordDeduction: async function (fid: number, amount: bigint) {
      deductions.push({ fid, amount });
      this.balance -= amount;
      return ('0x' + 'dd'.repeat(32)) as `0x${string}`;
    },
  };
}

function oracleStub(opts: { fail?: boolean; partial?: boolean } = {}) {
  const calls: OracleDispatchRequest[] = [];
  const fn = async (payload: OracleDispatchRequest): Promise<OracleDispatchResult> => {
    calls.push(payload);
    const cast = !!payload.parentHash;
    const mk = (model: string, i: number) => ({
      model, text: opts.fail ? '' : `${model} says ${i}`, hash: cast && !opts.fail ? `0x${model}` : '', hashes: [],
      modelId: `${model}-id`, tokens: 10, latencyMs: 100, ...(opts.fail ? { error: 'boom' } : {}),
    });
    const responses = payload.models.map((m, i) => mk(m, i));
    if (opts.partial) responses[0] = { ...responses[0], text: '', hash: '', error: 'boom' };
    return { processed: true, responses, answerHashes: responses.map(r => ({ model: r.model, hash: r.hash })) };
  };
  return { fn, calls };
}

const deps = (over: Partial<CouncilDeps> & { oracleCalls?: OracleDispatchRequest[] } = {}): CouncilDeps => ({
  rateLimit: async () => true,
  now: () => 1_700_000_000_000,
  ...over,
});

let counter = 0;
const fresh = () => `q-${++counter}-${Date.now()}`;

async function seedQuestion(id: string, stem: string, cast?: { hash: string; author: number; where: 'meta' | 'fc' }) {
  await env.DB.prepare(`INSERT OR IGNORE INTO queries (id, stem) VALUES (?, ?)`).bind(id, stem).run();
  if (cast?.where === 'meta') {
    await env.DB.prepare(`INSERT OR IGNORE INTO question_meta (question_id, cast_hash, author_fid) VALUES (?, ?, ?)`)
      .bind(id, cast.hash, cast.author).run();
  } else if (cast?.where === 'fc') {
    await env.DB.prepare(`INSERT OR IGNORE INTO farcaster_casts (id, entity_type, entity_id, cast_hash, cast_url, caster_fid) VALUES (?, 'query', ?, ?, '', ?)`)
      .bind(`fc-${id}`, id, cast.hash, cast.author).run();
  }
}

describe('CouncilService', () => {
  beforeAll(async () => {
    await env.DB.batch([
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS queries (id TEXT PRIMARY KEY, stem TEXT)`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS question_meta (question_id TEXT PRIMARY KEY, cast_hash TEXT, author_fid INTEGER)`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS farcaster_casts (id TEXT PRIMARY KEY, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, cast_hash TEXT NOT NULL, cast_url TEXT NOT NULL, caster_fid INTEGER NOT NULL)`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS council_summons (
        id TEXT PRIMARY KEY, question_id TEXT, fid INTEGER NOT NULL, source TEXT NOT NULL,
        summon_cast_hash TEXT UNIQUE, parent_cast_hash TEXT, price TEXT NOT NULL DEFAULT '0',
        status TEXT NOT NULL DEFAULT 'pending', deduction_tx TEXT, error TEXT,
        created_at INTEGER NOT NULL, answered_at INTEGER)`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS council_responses (
        id TEXT PRIMARY KEY, summon_id TEXT NOT NULL, question_id TEXT, parent_cast_hash TEXT,
        model TEXT NOT NULL, text TEXT NOT NULL, cast_hash TEXT, model_id TEXT, tokens INTEGER,
        latency_ms INTEGER, error TEXT, created_at INTEGER NOT NULL)`),
    ]);
    await seedQuestion(Q_CAST, 'Is water wet?', { hash: CAST_HASH, author: 42, where: 'meta' });
    await seedQuestion(Q_OLD, 'Old one', { hash: OLD_HASH, author: 43, where: 'fc' });
    await seedQuestion(Q_WEB, 'Web only');
  });

  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM council_responses`),
      env.DB.prepare(`DELETE FROM council_summons`),
    ]);
  });

  it('councilConfig parses the price and the gate', () => {
    expect(councilConfig({ COUNCIL_PRICE_QQ: '0' })).toMatchObject({ price: '0', gated: false, escrow_address: null });
    expect(councilConfig({})).toMatchObject({ price: '0', gated: false });
    expect(councilConfig({ COUNCIL_PRICE_QQ: 'abc' })).toMatchObject({ price: '0', gated: false });
    const c = councilConfig({ COUNCIL_PRICE_QQ: '50000', ORACLE_ESCROW_ADDRESS: '0x' + '1'.repeat(40) });
    expect(c.gated).toBe(true);
    expect(c.priceWei).toBe(parseUnits('50000', 18));
    expect(c.escrow_address).toBe('0x' + '1'.repeat(40));
  });

  it('questionIdForCast resolves question_meta first, farcaster_casts second', async () => {
    expect(await questionIdForCast(testEnv(), CAST_HASH)).toBe(Q_CAST);
    expect(await questionIdForCast(testEnv(), OLD_HASH)).toBe(Q_OLD);
    expect(await questionIdForCast(testEnv(), '0x' + '00'.repeat(20))).toBeNull();
  });

  it('gate off: dispatches with the question cast, persists three responses, charges nothing', async () => {
    const oracle = oracleStub();
    const escrow = escrowStub(0n);
    const r = await summon(testEnv(), { questionId: Q_CAST, fid: 7, source: 'web' }, deps({ oracle: oracle.fn, escrow }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.status).toBe('answered');
    expect(r.price).toBe('0');
    expect(r.responses.map(x => x.model)).toEqual(['chatqpt', 'qemini', 'qlaude']);
    expect(r.responses.find(x => x.model === 'qlaude')?.cast_hash).toBe('0xqlaude');
    expect(oracle.calls).toHaveLength(1);
    expect(oracle.calls[0]).toMatchObject({ question: 'Is water wet?', parentHash: CAST_HASH, parentAuthorFid: 42, ledgerKey: `summon:${r.summonId}`, askerFid: 7 });
    expect(escrow.deductions).toEqual([]);
    const row = await env.DB.prepare(`SELECT status, price, deduction_tx FROM council_summons WHERE id = ?`).bind(r.summonId).first();
    expect(row).toMatchObject({ status: 'answered', price: '0', deduction_tx: null });
  });

  it('a question with no cast dispatches without a parent; the ledger key is the summon id', async () => {
    const oracle = oracleStub();
    const r = await summon(testEnv(), { questionId: Q_WEB, fid: 7, source: 'web' }, deps({ oracle: oracle.fn, escrow: null }));
    expect(r.ok).toBe(true);
    expect(oracle.calls[0].parentHash).toBeUndefined();
    if (r.ok) expect(oracle.calls[0].ledgerKey).toBe(`summon:${r.summonId}`);
    if (r.ok) expect(r.responses.every(x => x.cast_hash === null)).toBe(true);
  });

  it('older questions find their cast in farcaster_casts', async () => {
    const oracle = oracleStub();
    await summon(testEnv(), { questionId: Q_OLD, fid: 7, source: 'web' }, deps({ oracle: oracle.fn, escrow: null }));
    expect(oracle.calls[0]).toMatchObject({ parentHash: OLD_HASH, parentAuthorFid: 43 });
  });

  it('gated + no stake → stake_required, no model call, no summons row', async () => {
    const oracle = oracleStub();
    const escrow = escrowStub(parseUnits('10', 18));
    const e = testEnv({ COUNCIL_PRICE_QQ: '100', ORACLE_ESCROW_ADDRESS: '0x' + '1'.repeat(40) });
    const r = await summon(e, { questionId: Q_CAST, fid: 7, source: 'web' }, deps({ oracle: oracle.fn, escrow }));
    expect(r).toMatchObject({ ok: false, code: 'stake_required', price: '100', balance: parseUnits('10', 18).toString(), stake_url: '/stake' });
    expect(oracle.calls).toHaveLength(0);
    const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM council_summons`).first() as { n: number };
    expect(n.n).toBe(0);
  });

  it('gated + enough stake → answers, then exactly one deduction of the price', async () => {
    const oracle = oracleStub();
    const escrow = escrowStub(parseUnits('250', 18));
    const e = testEnv({ COUNCIL_PRICE_QQ: '100', ORACLE_ESCROW_ADDRESS: '0x' + '1'.repeat(40) });
    const r = await summon(e, { questionId: Q_CAST, fid: 7, source: 'web' }, deps({ oracle: oracle.fn, escrow }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.price).toBe('100');
    expect(escrow.deductions).toEqual([{ fid: 7, amount: parseUnits('100', 18) }]);
    const row = await env.DB.prepare(`SELECT status, price, deduction_tx FROM council_summons WHERE id = ?`).bind(r.summonId).first();
    expect(row).toMatchObject({ status: 'answered', price: '100', deduction_tx: '0x' + 'dd'.repeat(32) });
  });

  it('gated with the price set but no escrow → escrow_unconfigured (never free by accident)', async () => {
    const oracle = oracleStub();
    const r = await summon(testEnv({ COUNCIL_PRICE_QQ: '100' }), { questionId: Q_CAST, fid: 7, source: 'web' }, deps({ oracle: oracle.fn, escrow: null }));
    expect(r).toMatchObject({ ok: false, code: 'escrow_unconfigured' });
    expect(oracle.calls).toHaveLength(0);
  });

  it('already answered → returns the thread, no dispatch, no charge', async () => {
    const oracle = oracleStub();
    const escrow = escrowStub(parseUnits('1000', 18));
    const e = testEnv({ COUNCIL_PRICE_QQ: '100', ORACLE_ESCROW_ADDRESS: '0x' + '1'.repeat(40) });
    const first = await summon(e, { questionId: Q_CAST, fid: 7, source: 'web' }, deps({ oracle: oracle.fn, escrow }));
    const second = await summon(e, { questionId: Q_CAST, fid: 8, source: 'cast', summonCastHash: '0x' + 'ee'.repeat(20), parentCastHash: CAST_HASH, parentAuthorFid: 42 }, deps({ oracle: oracle.fn, escrow }));
    expect(first.ok && first.status).toBe('answered');
    expect(second.ok && second.status).toBe('already_answered');
    expect(oracle.calls).toHaveLength(1);
    expect(escrow.deductions).toHaveLength(1);
    expect(await listResponses(e, Q_CAST)).toHaveLength(3);
  });

  it('asking again: paid → a new round with its own deduction; free → refused, no dispatch', async () => {
    const oracle = oracleStub();
    const escrow = escrowStub(parseUnits('1000', 18));
    const gated = testEnv({ COUNCIL_PRICE_QQ: '100', ORACLE_ESCROW_ADDRESS: '0x' + '1'.repeat(40) });
    let clock = 1_700_000_000_000;
    const ticking = () => (clock += 1000); // rounds must not share a timestamp: the thread orders by it
    const first = await summon(gated, { questionId: Q_CAST, fid: 7, source: 'web' }, deps({ oracle: oracle.fn, escrow, now: ticking }));
    const view = await summon(gated, { questionId: Q_CAST, fid: 8, source: 'web' }, deps({ oracle: oracle.fn, escrow, now: ticking }));
    const again = await summon(gated, { questionId: Q_CAST, fid: 8, source: 'web', again: true }, deps({ oracle: oracle.fn, escrow, now: ticking }));
    expect(first.ok && first.status).toBe('answered');
    expect(view.ok && view.status).toBe('already_answered');
    expect(again.ok && again.status).toBe('answered');
    expect(oracle.calls).toHaveLength(2);
    expect(escrow.deductions).toEqual([{ fid: 7, amount: parseUnits('100', 18) }, { fid: 8, amount: parseUnits('100', 18) }]);
    if (first.ok && again.ok) {
      expect(again.summonId).not.toBe(first.summonId);
      // The result carries the whole thread, newest round first.
      expect(again.responses).toHaveLength(6);
      expect(new Set(again.responses.map(x => x.summon_id)).size).toBe(2);
      expect(again.responses[0].summon_id).toBe(again.summonId);
    }
    expect(await listResponses(gated, Q_CAST)).toHaveLength(6);

    const free = testEnv();
    const refused = await summon(free, { questionId: Q_CAST, fid: 9, source: 'web', again: true }, deps({ oracle: oracle.fn, escrow: null }));
    expect(refused).toMatchObject({ ok: false, code: 'resummon_requires_payment' });
    expect(oracle.calls).toHaveLength(2);
  });

  it('the same summon cast delivered twice → one summons row, one dispatch', async () => {
    const oracle = oracleStub({ fail: true });   // fail so "already answered" does not mask the replay rule
    const summonHash = '0x' + 'cc'.repeat(20);
    const input = { questionId: Q_CAST, fid: 9, source: 'cast' as const, summonCastHash: summonHash, parentCastHash: CAST_HASH, parentAuthorFid: 42 };
    const a = await summon(testEnv(), input, deps({ oracle: oracle.fn, escrow: null }));
    const b = await summon(testEnv(), input, deps({ oracle: oracle.fn, escrow: null }));
    expect(a).toMatchObject({ ok: false, code: 'dispatch_failed' });
    expect(b.ok && b.status).toBe('replayed');
    expect(oracle.calls).toHaveLength(1);
    const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM council_summons WHERE summon_cast_hash = ?`).bind(summonHash).first() as { n: number };
    expect(n.n).toBe(1);
  });

  it('every model failed → summons failed, responses kept with errors, nothing deducted', async () => {
    const oracle = oracleStub({ fail: true });
    const escrow = escrowStub(parseUnits('1000', 18));
    const e = testEnv({ COUNCIL_PRICE_QQ: '100', ORACLE_ESCROW_ADDRESS: '0x' + '1'.repeat(40) });
    const r = await summon(e, { questionId: Q_CAST, fid: 7, source: 'web' }, deps({ oracle: oracle.fn, escrow }));
    expect(r).toMatchObject({ ok: false, code: 'dispatch_failed' });
    expect(escrow.deductions).toEqual([]);
    const row = await env.DB.prepare(`SELECT status, error FROM council_summons`).first();
    expect(row).toMatchObject({ status: 'failed', error: 'every model failed' });
  });

  it('after a fully failed summon the question can be summoned again; failed rows stay out of the thread', async () => {
    const e = testEnv();
    await summon(e, { questionId: Q_CAST, fid: 7, source: 'web' }, deps({ oracle: oracleStub({ fail: true }).fn, escrow: null }));
    expect(await listResponses(e, Q_CAST)).toHaveLength(0);
    expect(await listResponses(e, Q_CAST, { includeFailed: true })).toHaveLength(3);
    const again = await summon(e, { questionId: Q_CAST, fid: 7, source: 'web' }, deps({ oracle: oracleStub().fn, escrow: null }));
    expect(again.ok && again.status).toBe('answered');
    expect(await listResponses(e, Q_CAST)).toHaveLength(3);
  });

  it('a partial answer still counts (and charges); the failed model is stored with its error', async () => {
    const oracle = oracleStub({ partial: true });
    const escrow = escrowStub(parseUnits('1000', 18));
    const e = testEnv({ COUNCIL_PRICE_QQ: '100', ORACLE_ESCROW_ADDRESS: '0x' + '1'.repeat(40) });
    const r = await summon(e, { questionId: Q_CAST, fid: 7, source: 'web' }, deps({ oracle: oracle.fn, escrow }));
    expect(r.ok).toBe(true);
    expect(escrow.deductions).toHaveLength(1);
    if (r.ok) expect(r.responses).toHaveLength(2); // the thread carries answers only
    const all = await listResponses(e, Q_CAST, { includeFailed: true });
    expect(all.filter(x => x.error).length).toBe(1); // the failed model stays as audit
  });

  it('a deduction failure after answers is recorded on the summons, answers still returned', async () => {
    const oracle = oracleStub();
    const escrow = { availableBalance: async () => parseUnits('1000', 18), recordDeduction: async () => { throw new Error('rpc down'); } };
    const e = testEnv({ COUNCIL_PRICE_QQ: '100', ORACLE_ESCROW_ADDRESS: '0x' + '1'.repeat(40) });
    const r = await summon(e, { questionId: Q_CAST, fid: 7, source: 'web' }, deps({ oracle: oracle.fn, escrow }));
    expect(r.ok).toBe(true);
    const row = await env.DB.prepare(`SELECT status, error, deduction_tx FROM council_summons`).first() as { status: string; error: string; deduction_tx: string | null };
    expect(row.status).toBe('answered');
    expect(row.deduction_tx).toBeNull();
    expect(row.error).toContain('deduction_failed');
  });

  it('rate limited → no dispatch', async () => {
    const oracle = oracleStub();
    const r = await summon(testEnv(), { questionId: Q_CAST, fid: 7, source: 'web' }, deps({ oracle: oracle.fn, escrow: null, rateLimit: async () => false }));
    expect(r).toMatchObject({ ok: false, code: 'rate_limited' });
    expect(oracle.calls).toHaveLength(0);
  });

  it('unknown question → question_not_found; untracked cast with text still works', async () => {
    const oracle = oracleStub();
    expect(await summon(testEnv(), { questionId: fresh(), fid: 7, source: 'web' }, deps({ oracle: oracle.fn, escrow: null })))
      .toMatchObject({ ok: false, code: 'question_not_found' });
    const untracked = '0x' + '99'.repeat(20);
    const r = await summon(testEnv(), { fid: 7, source: 'cast', summonCastHash: '0x' + '98'.repeat(20), parentCastHash: untracked, parentAuthorFid: 5, questionText: 'Untracked?' }, deps({ oracle: oracle.fn, escrow: null }));
    expect(r.ok && r.status).toBe('answered');
    expect(oracle.calls).toHaveLength(1);
    expect(oracle.calls[0]).toMatchObject({ question: 'Untracked?', parentHash: untracked, parentAuthorFid: 5 });
    if (r.ok) expect(r.responses[0].question_id).toBeNull();
  });

  it('a second web summon while the first is in flight → in_flight; the lock is released afterwards', async () => {
    const e = testEnv();
    let release!: () => void;
    const gate = new Promise<void>(res => { release = res; });
    const slowOracle = async (p: OracleDispatchRequest) => { await gate; return oracleStub().fn(p); };
    const first = summon(e, { questionId: Q_CAST, fid: 7, source: 'web' }, deps({ oracle: slowOracle, escrow: null }));
    await new Promise(r => setTimeout(r, 20));
    const second = await summon(e, { questionId: Q_CAST, fid: 8, source: 'web' }, deps({ oracle: oracleStub().fn, escrow: null }));
    expect(second).toMatchObject({ ok: false, code: 'in_flight' });
    release();
    expect((await first).ok).toBe(true);
    expect(e.KV_FRAME_NOTIFICATIONS.store.size).toBe(0);
  });

  it('viewerStake: free → can summon; gated without escrow → cannot; gated with balance → compares', async () => {
    expect(await viewerStake(testEnv(), 7)).toEqual({ balance: null, can_summon: true });
    const gated = testEnv({ COUNCIL_PRICE_QQ: '100' });
    expect(await viewerStake(gated, 7, { escrow: null })).toEqual({ balance: null, can_summon: false });
    expect(await viewerStake(gated, 7, { escrow: escrowStub(parseUnits('100', 18)) })).toEqual({ balance: parseUnits('100', 18).toString(), can_summon: true });
    expect(await viewerStake(gated, 7, { escrow: escrowStub(parseUnits('99', 18)) })).toMatchObject({ can_summon: false });
  });
});
