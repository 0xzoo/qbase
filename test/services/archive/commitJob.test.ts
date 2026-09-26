/**
 * archive:commit(pollId) against local D1 with a fake ENS and a fake Turbo:
 * idempotent on poll_id, one transaction per wave, the Arweave fallback, a
 * question without a name waits, a reverted transaction is re-sent.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { commitWave, getCommitment, nameOpenWaveQuestions, sweepClosedWaves, type CommitEnv } from '../../../worker/services/archive/WaveCommitJob';
import { signDataItem } from '../../../worker/services/archive/ArweaveService';
import type { EnsPort, WaveRecords, ReceiptState } from '../../../worker/services/archive/EnsService';
import { Q, WAVE, createSchema, seed } from './fixtures';

const PK = `0x${'22'.repeat(32)}`;
const NOW = () => new Date('2026-09-26T00:00:00Z');

function fakeEns(opts: { named?: boolean; namer?: boolean; receipts?: ReceiptState[] } = {}) {
  const sent: Array<{ name: string; records: WaveRecords }> = [];
  const registered: string[] = [];
  const questionRecords: Array<{ name: string; stem: string }> = [];
  const receipts = [...(opts.receipts ?? [])];
  let named = opts.named ?? true;
  let text: string | null = named ? 'already written' : null;
  const port: EnsPort = {
    chainId: 11155111,
    isNamed: async () => named,
    canName: () => opts.namer ?? false,
    register: async (label) => { registered.push(label); named = true; return `0x${'e'.repeat(64)}`; },
    writeQuestionRecords: async (name, q) => { questionRecords.push({ name, stem: q.stem }); text = q.stem; return `0x${'f'.repeat(64)}`; },
    commit: async (name, records) => { sent.push({ name, records }); return `0x${String(sent.length).padStart(64, '0')}`; },
    receipt: async () => receipts.shift() ?? 'success',
    readWaveHash: async () => null,
    readText: async () => text,
  };
  return { port, sent, registered, questionRecords };
}

/** Turbo stand-in: answers with the id the item would have. */
function fakeTurbo(ok = true) {
  const posted: Uint8Array[] = [];
  const f = (async (_url: string, init: RequestInit) => {
    posted.push(init.body as Uint8Array);
    if (!ok) return new Response('boom', { status: 503 });
    const sig = (init.body as Uint8Array).slice(2, 67);
    const id = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', sig)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return new Response(JSON.stringify({ id }));
  }) as unknown as typeof fetch;
  return { f, posted };
}

const baseEnv = (extra: Partial<CommitEnv> = {}): CommitEnv => ({ DB: env.DB, HOSTNAME: 'qbase-dev.example', ENS_WRITES_ENABLED: '1', ARCHIVE_PRIVATE_KEY: PK, ...extra });

describe('commitWave', () => {
  beforeAll(createSchema);
  beforeEach(() => seed());

  it('does nothing unless ENS_WRITES_ENABLED = "1"', async () => {
    expect(await commitWave(baseEnv({ ENS_WRITES_ENABLED: undefined }), WAVE, { now: NOW })).toEqual({ status: 'disabled' });
    expect(await getCommitment({ DB: env.DB }, WAVE)).toBeNull();
  });

  it('refuses an open wave', async () => {
    await seed({ closesAt: '2999-01-01T00:00:00Z' });
    expect((await commitWave(baseEnv(), WAVE, { now: NOW })).status).toBe('not_closed');
  });

  it('posts to Arweave, sends one multicall with the §7.3 records, and is idempotent', async () => {
    const ens = fakeEns();
    const turbo = fakeTurbo();
    const out = await commitWave(baseEnv(), WAVE, { ens: ens.port, fetch: turbo.f, now: NOW, receiptWaitMs: 0 });
    expect(out.status).toBe('committed');
    const row = (await getCommitment({ DB: env.DB }, WAVE))!;
    expect(row.ar_tx).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(row.tx_hash).toBe(`0x${'1'.padStart(64, '0')}`);
    expect(row.lease_until).toBeNull();

    expect(ens.sent).toHaveLength(1);
    const { name, records } = ens.sent[0];
    expect(name).toBe(`${Q}.q.askqbase.eth`);
    expect(records.waves).toEqual([WAVE]);
    expect(records.bundleSha256).toBe(row.bundle_sha256);
    expect(records.contenthash).toMatch(/^0x90b2ca05[0-9a-f]{64}$/);
    const summary = JSON.parse(records.summary);
    expect(summary).toMatchObject({ n: 3, n_verified: 1, gate: 'world_id:proof_of_human', published_by: '@zoo', closed_at: '2026-09-25T00:00:00Z', bundle: `ar://${row.ar_tx}` });
    expect(Object.keys(summary)).toEqual(['bundle', 'closed_at', 'gate', 'n', 'n_verified', 'published_by', 'tally_sha256']);

    // the Arweave item carries the bundle bytes and is signed by the archive key
    const item = turbo.posted[0];
    expect(new TextDecoder().decode(item.slice(item.length - row.bundle_json.length))).toBe(row.bundle_json);
    const expectedOwner = (await signDataItem(PK as `0x${string}`, new Uint8Array(0), [])).owner;
    expect(`0x${[...item.slice(67, 132)].map((b) => b.toString(16).padStart(2, '0')).join('')}`).toBe(expectedOwner);

    // run again: nothing new is posted or sent
    const again = await commitWave(baseEnv(), WAVE, { ens: ens.port, fetch: turbo.f, now: NOW, receiptWaitMs: 0 });
    expect(again.status).toBe('committed');
    expect(ens.sent).toHaveLength(1);
    expect(turbo.posted).toHaveLength(1);
  });

  it('keeps the first bundle even if a handle changes between attempts', async () => {
    const ens = fakeEns({ named: false });
    await commitWave(baseEnv(), WAVE, { ens: ens.port, fetch: fakeTurbo().f, now: NOW, receiptWaitMs: 0 });
    const first = (await getCommitment({ DB: env.DB }, WAVE))!.bundle_sha256;
    await env.DB.prepare(`UPDATE Users SET fname = 'robert' WHERE fid = 3`).run();
    await commitWave(baseEnv(), WAVE, { ens: fakeEns().port, fetch: fakeTurbo().f, now: NOW, receiptWaitMs: 0 });
    expect((await getCommitment({ DB: env.DB }, WAVE))!.bundle_sha256).toBe(first);
  });

  it('falls back to the qbase-served bundle when Arweave fails, and leaves contenthash unset', async () => {
    const ens = fakeEns();
    const out = await commitWave(baseEnv(), WAVE, { ens: ens.port, fetch: fakeTurbo(false).f, now: NOW, receiptWaitMs: 0 });
    expect(out.status).toBe('committed');
    const row = (await getCommitment({ DB: env.DB }, WAVE))!;
    expect(row.ar_tx).toBeNull();
    expect(row.ar_error).toContain('503');
    expect(ens.sent[0].records.contenthash).toBeNull();
    expect(JSON.parse(ens.sent[0].records.summary).bundle).toBe(`https://qbase-dev.example/api/archive/waves/${WAVE}/bundle`);
  });

  it('names an unnamed question from the namer key, then commits', async () => {
    const ens = fakeEns({ named: false, namer: true });
    const out = await commitWave(baseEnv(), WAVE, { ens: ens.port, fetch: fakeTurbo().f, now: NOW, receiptWaitMs: 0 });
    expect(out.status).toBe('committed');
    expect(ens.registered).toEqual([Q]);
    expect(ens.questionRecords).toEqual([{ name: `${Q}.q.askqbase.eth`, stem: 'should corporations have the right to vote?' }]);
    expect(ens.sent).toHaveLength(1);
  });

  it('names the questions of open waves (and leaves named ones alone)', async () => {
    await seed({ closesAt: '2999-01-01T00:00:00Z' });
    const ens = fakeEns({ named: false, namer: true });
    const env1 = baseEnv({ ARCHIVE_SINCE: '2026-09-01T00:00:00Z' });
    expect(await nameOpenWaveQuestions(env1, { ens: ens.port, now: NOW, receiptWaitMs: 0 })).toEqual([{ question_id: Q, status: 'named' }]);
    expect(await nameOpenWaveQuestions(env1, { ens: ens.port, now: NOW, receiptWaitMs: 0 })).toEqual([{ question_id: Q, status: 'named' }]);
    expect(ens.registered).toHaveLength(1);
    expect(ens.questionRecords).toHaveLength(1);
    expect(await nameOpenWaveQuestions(baseEnv(), { ens: ens.port, now: NOW })).toEqual([]); // no ARCHIVE_SINCE
  });

  it('waits for a name when no namer key is set', async () => {
    const ens = fakeEns({ named: false });
    const out = await commitWave(baseEnv(), WAVE, { ens: ens.port, fetch: fakeTurbo().f, now: NOW, receiptWaitMs: 0 });
    expect(out.status).toBe('awaiting_name');
    expect(ens.sent).toHaveLength(0);
    expect((await getCommitment({ DB: env.DB }, WAVE))!.error).toContain('grant-namer.ts');
  });

  it('a pending receipt is settled by the next run, never re-sent', async () => {
    const ens = fakeEns({ receipts: ['pending', 'success'] });
    const turbo = fakeTurbo();
    expect((await commitWave(baseEnv(), WAVE, { ens: ens.port, fetch: turbo.f, now: NOW, receiptWaitMs: 0 })).status).toBe('submitted');
    expect((await commitWave(baseEnv(), WAVE, { ens: ens.port, fetch: turbo.f, now: NOW, receiptWaitMs: 0 })).status).toBe('committed');
    expect(ens.sent).toHaveLength(1);
  });

  it('a reverted transaction is re-sent', async () => {
    const ens = fakeEns({ receipts: ['reverted', 'success'] });
    const turbo = fakeTurbo();
    expect((await commitWave(baseEnv(), WAVE, { ens: ens.port, fetch: turbo.f, now: NOW, receiptWaitMs: 0 })).status).toBe('posted');
    expect((await commitWave(baseEnv(), WAVE, { ens: ens.port, fetch: turbo.f, now: NOW, receiptWaitMs: 0 })).status).toBe('committed');
    expect(ens.sent).toHaveLength(2);
  });

  it('a held lease turns a concurrent run away', async () => {
    await commitWave(baseEnv(), WAVE, { ens: fakeEns({ named: false }).port, fetch: fakeTurbo().f, now: NOW, receiptWaitMs: 0 });
    await env.DB.prepare(`UPDATE wave_commitments SET lease_until = '2999-01-01T00:00:00Z'`).run();
    const ens = fakeEns();
    expect((await commitWave(baseEnv(), WAVE, { ens: ens.port, fetch: fakeTurbo().f, now: NOW })).status).toBe('busy');
    expect(ens.sent).toHaveLength(0);
  });

  it('the sweep takes only waves closed after ARCHIVE_SINCE, and nothing when it is unset', async () => {
    const deps = { ens: fakeEns().port, fetch: fakeTurbo().f, now: NOW, receiptWaitMs: 0 };
    expect(await sweepClosedWaves(baseEnv(), deps)).toEqual([]);
    expect(await sweepClosedWaves(baseEnv({ ARCHIVE_SINCE: '2026-09-25T00:00:00Z' }), deps)).toEqual([]);
    expect(await sweepClosedWaves(baseEnv({ ARCHIVE_SINCE: '2026-09-24T00:00:00Z' }), deps)).toEqual([{ poll_id: WAVE, status: 'committed' }]);
  });
});
