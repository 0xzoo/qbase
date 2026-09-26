/**
 * The committed wave bundle (plan 2026-09-25 §7.3–§7.4, §8.7): canonical
 * JSON, the results page's own tally, Public rows only, n_verified a count.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { canonicalJson, sha256Hex } from '../../../worker/services/archive/canonicalJson';
import { buildWaveBundle, gateRule, liveTally } from '../../../worker/services/archive/WaveBundle';
import { getPoll } from '../../../worker/services/PollService';
import { ACCOUNT, Q, WAVE, createSchema, seed } from './fixtures';

describe('canonicalJson (RFC 8785)', () => {
  it('sorts keys by UTF-16 code units at every depth and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: [{ z: null, y: 'é' }], c: undefined, A: true })).toBe('{"A":true,"a":[{"y":"é","z":null}],"b":1}');
  });
  it('matches the RFC 8785 number and string examples', () => {
    // RFC 8785 §3.2.3's own input: the literal is meant to round
    // eslint-disable-next-line no-loss-of-precision
    expect(canonicalJson({ numbers: [333333333.33333329, 1e30, 4.5, 0.002, 1e-27], string: '€$\u000f\nA\'B"\\\\"/' }))
      .toBe('{"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}');
  });
  it('refuses non-finite numbers', () => {
    expect(() => canonicalJson({ n: NaN })).toThrow();
  });
  it('hashes the question text the way setup.ts writes qbase.canonical', async () => {
    expect(await sha256Hex('should corporations have the right to vote?')).toBe('0xcc60a312a77b219bf03c0e5e98986f7a811616d169a2ebee8253678f07b2cf8a');
  });
});

describe('buildWaveBundle', () => {
  beforeAll(createSchema);
  beforeEach(() => seed());

  it('commits the wave tally, Public rows only, and a verified count', async () => {
    const poll = (await getPoll(env.DB, WAVE))!;
    const built = (await buildWaveBundle({ DB: env.DB, HOSTNAME: 'qbase-dev.example' }, poll))!;
    const b = built.bundle;
    expect(b.schema).toBe('qbase.wave.v1');
    expect(b.question).toMatchObject({ id: Q, ens_name: `${Q}.q.askqbase.eth`, type: 'mc', options: ['yes', 'no'] });
    expect(b.wave).toMatchObject({ id: WAVE, gate: 'world_id:proof_of_human', published_by: '@zoo', closed_at: '2026-09-25T00:00:00Z' });
    // alice no, bob no (latest), anon yes; the Secret row and the direct answer are not in the wave tally
    expect(b.tally).toEqual({ type: 'mc', total: 3, distribution: [{ label: 'yes', count: 1 }, { label: 'no', count: 2 }] });
    expect(b.n).toBe(3);
    expect(b.n_verified).toBe(1);
    expect(b.rows.map((r) => r.id)).toEqual(['a1', 'a2', 'a3']);
    expect(b.rows[0]).toEqual({ id: 'a1', answer: 'no', answered_at: '2026-09-21T00:00:00Z', handle: 'alice', fid: 555, account: ACCOUNT });
    expect(b.rows[1]).toMatchObject({ handle: 'bob', fid: 3, account: null });
    expect(built.json).not.toContain('514282');
    expect(built.json).not.toContain('encrypted');
    expect(built.json).not.toContain('123'); // no nullifier
    expect(built.json).toBe(canonicalJson(JSON.parse(built.json)));
    expect(built.sha256).toBe(await sha256Hex(built.json));
  });

  it('is deterministic, and the live tally equals the committed one until a row changes', async () => {
    const poll = (await getPoll(env.DB, WAVE))!;
    const one = (await buildWaveBundle({ DB: env.DB }, poll))!;
    const two = (await buildWaveBundle({ DB: env.DB }, poll))!;
    expect(two.sha256).toBe(one.sha256);
    expect(await liveTally({ DB: env.DB }, poll)).toEqual(one.bundle.tally);
    await env.DB.prepare(`UPDATE Answers SET value = 'yes' WHERE id = 'a1'`).run();
    expect(await liveTally({ DB: env.DB }, poll)).not.toEqual(one.bundle.tally);
  });

  it('describes each gate without its FID list', () => {
    expect(gateRule(null)).toBe('open');
    expect(gateRule('{"type":"nft_snapshot","contract":"0xABC","chain":"base","snapshot_fids":[1,2],"holder_address_count":2,"snapshotted_at":"x"}')).toBe('nft_snapshot:base:0xabc');
    expect(gateRule('{"type":"token_snapshot","contract":"0xABC","chain":"base","min_balance":"100","min_balance_wei":"1","decimals":18,"snapshot_fids":[1],"holder_address_count":1,"snapshotted_at":"x"}')).toBe('token_snapshot:base:0xabc:>=100');
  });
});
