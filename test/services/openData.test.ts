/**
 * The open release (worker/services/OpenDataService.ts): the floor, the
 * complementary withhold, labels, release eligibility, and the CSV. Also the
 * scale fix in AggregateResultsService: Anon rows share a placeholder
 * user_id, so the per-value histogram must partition by person key.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import {
  buildScope, floorCounts, getOpenItem, listOpenItems, openItemCsv, OPEN_FLOOR,
} from '../../worker/services/OpenDataService';
import { getAggregateResults } from '../../worker/services/AggregateResultsService';

const ANON_PLACEHOLDER = 3;
const ORIGIN = 'https://qbase.test';

describe('open data / floorCounts', () => {
  it('withholds 1..floor-1 and keeps zeros', () => {
    expect(floorCounts([12, 0, 4, 30], 10, false)).toEqual([12, 0, null, 30]);
  });

  it('a lone withheld cell takes the next-smallest non-zero cell with it when cells sum to n', () => {
    expect(floorCounts([12, 0, 4, 30], 10, true)).toEqual([null, 0, null, 30]);
  });

  it('two withheld cells need no extra withhold', () => {
    expect(floorCounts([3, 4, 30], 10, true)).toEqual([null, null, 30]);
  });
});

describe('open data / buildScope', () => {
  const rows = (spec: Array<[string, string, number]>) =>
    spec.flatMap(([value, audience, k]) => Array.from({ length: k }, () => ({ value, audience })));

  it('a scope under the floor publishes n only', () => {
    const s = buildScope(rows([['yes', 'Public', 9]]), 'mc', ['yes', 'no'], (v) => [v]);
    expect(s).toEqual({ n: 9, below_floor: true, tiers: null, distribution: [] });
  });

  it('undeclared labels count as other and are never named', () => {
    const s = buildScope(rows([['yes', 'Public', 20], ['no', 'Anon', 15], ['slur', 'Public', 12]]), 'mc', ['yes', 'no'], (v) => [v]);
    expect(s.distribution.map((c) => c.label)).toEqual(['yes', 'no', 'other']);
    expect(s.distribution[2]).toEqual({ label: 'other', count: 12, pct: 26 });
    expect(s.tiers).toEqual({ public: 32, anon: 15 });
  });

  it('a small tier split is withheld on both sides', () => {
    const s = buildScope(rows([['yes', 'Public', 20], ['no', 'Anon', 3]]), 'mc', ['yes', 'no'], (v) => [v]);
    expect(s.tiers).toEqual({ public: null, anon: null });
  });

  it('checkbox cells are independent: no complementary withhold', () => {
    const s = buildScope(rows([['a, b', 'Public', 10], ['a', 'Public', 2]]), 'checkbox', ['a', 'b', 'c'],
      (v) => v.split(',').map((x) => x.trim()));
    expect(s.distribution).toEqual([
      { label: 'a', count: 12, pct: 100 },
      { label: 'b', count: 10, pct: 83 },
      { label: 'c', count: 0, pct: 0 },
    ]);
  });
});

describe('open data / release over D1', () => {
  beforeAll(async () => {
    for (const sql of [
      `CREATE TABLE IF NOT EXISTS queries (id TEXT PRIMARY KEY, stem TEXT, type TEXT, a_options TEXT, scale_config TEXT, created_at TEXT, coiner_fname TEXT, coiner_fid INTEGER, taxonomy TEXT)`,
      `CREATE TABLE IF NOT EXISTS Answers (id TEXT PRIMARY KEY, q_id TEXT NOT NULL, user_id INTEGER, value TEXT, answer_type_id TEXT, answer_data TEXT, audience TEXT, created_at TEXT, storage_ref TEXT, poll_id TEXT, quiz_completion_id TEXT)`,
      `CREATE TABLE IF NOT EXISTS anon_attributions (id TEXT PRIMARY KEY, public_id TEXT NOT NULL UNIQUE, author_id INTEGER, author_tag TEXT, author_ct TEXT, type TEXT NOT NULL, created_at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS polls (id TEXT PRIMARY KEY, question_id TEXT NOT NULL, closes_at TEXT NOT NULL, eligibility_gate TEXT, options_config TEXT, author_fid INTEGER, cast_hash TEXT, channel_id TEXT, kind TEXT NOT NULL DEFAULT 'measure', created_at TEXT NOT NULL)`,
      `INSERT OR IGNORE INTO queries (id, stem, type, a_options, created_at) VALUES
         ('q-open', 'Should X?', 'mc', '["Yes","No"]', '2026-09-01T00:00:00.000Z'),
         ('q-small', 'Tiny?', 'mc', '["Yes","No"]', '2026-09-01T00:00:00.000Z'),
         ('q-text', 'Why?', 'text', NULL, '2026-09-01T00:00:00.000Z')`,
      `INSERT OR IGNORE INTO queries (id, stem, type, a_options, created_at, taxonomy) VALUES
         ('q-help', 'Which laptop?', 'mc', '["A","B"]', '2026-09-01T00:00:00.000Z', '{"intent":"request"}')`,
      `INSERT OR IGNORE INTO queries (id, stem, type, scale_config, created_at) VALUES
         ('q-scale', 'Rate it', 'scale', '{"min":1,"max":5}', '2026-09-01T00:00:00.000Z')`,
      `INSERT OR IGNORE INTO polls (id, question_id, closes_at, eligibility_gate, created_at) VALUES
         ('w-1', 'q-open', '2026-09-10T00:00:00.000Z', '{"type":"world_id"}', '2026-09-02T00:00:00.000Z')`,
    ]) await env.DB.prepare(sql).run();

    const inserts: string[] = [];
    // q-open: 22 Public (12 Yes, 10 No; user 100 answered twice: No then Yes) + 4 Anon (No), 3 Private ignored.
    for (let i = 0; i < 12; i++) inserts.push(`('o-p${i}', 'q-open', ${100 + i}, 'Yes', '2', 'Public', '2026-09-0${(i % 8) + 2}T00:00:0${i % 10}.000Z', ${i < 6 ? "'w-1'" : 'NULL'})`);
    inserts.push(`('o-old', 'q-open', 100, 'No', '2', 'Public', '2026-09-01T00:00:00.000Z', NULL)`);
    for (let i = 12; i < 22; i++) inserts.push(`('o-p${i}', 'q-open', ${100 + i}, 'No', '2', 'Public', '2026-09-03T00:00:0${i % 10}.000Z', NULL)`);
    for (let i = 0; i < 4; i++) inserts.push(`('o-a${i}', 'q-open', ${ANON_PLACEHOLDER}, 'No', '2', 'Anon', '2026-09-04T00:00:0${i}.000Z', NULL)`);
    for (let i = 0; i < 3; i++) inserts.push(`('o-s${i}', 'q-open', ${200 + i}, '[encrypted]', '2', 'Private', '2026-09-04T00:00:0${i}.000Z', NULL)`);
    for (let i = 0; i < 5; i++) inserts.push(`('s-p${i}', 'q-small', ${100 + i}, 'Yes', '2', 'Public', '2026-09-02T00:00:0${i}.000Z', NULL)`);
    for (let i = 0; i < 12; i++) inserts.push(`('h-p${i}', 'q-help', ${100 + i}, 'A', '2', 'Public', '2026-09-02T00:00:0${i % 10}.000Z', NULL)`);
    // q-scale: 10 Public 4s + 3 Anon 5s.
    for (let i = 0; i < 10; i++) inserts.push(`('c-p${i}', 'q-scale', ${100 + i}, '4', '3', 'Public', '2026-09-02T00:00:0${i}.000Z', NULL)`);
    for (let i = 0; i < 3; i++) inserts.push(`('c-a${i}', 'q-scale', ${ANON_PLACEHOLDER}, '5', '3', 'Anon', '2026-09-03T00:00:0${i}.000Z', NULL)`);
    await env.DB.prepare(`INSERT OR IGNORE INTO Answers (id, q_id, user_id, value, answer_type_id, audience, created_at, poll_id) VALUES ${inserts.join(',\n')}`).run();

    const tags = [...[0, 1, 2, 3].map((i) => [`o-a${i}`, `tag-o${i}`]), ...[0, 1, 2].map((i) => [`c-a${i}`, `tag-c${i}`])];
    for (const [publicId, tag] of tags) {
      await env.DB.prepare(`INSERT OR IGNORE INTO anon_attributions (id, public_id, author_tag, type, created_at) VALUES (?, ?, ?, 'answer', '2026-09-04')`)
        .bind(`attr-${publicId}`, publicId, tag).run();
    }
  });

  it('releases a question at or over the floor, latest answer per person, Public + Anon only', async () => {
    const item = await getOpenItem(env.DB, 'q-open', ORIGIN);
    expect(item).not.toBeNull();
    expect(item!.license.id).toBe('CC-BY-4.0');
    expect(item!.floor).toBe(OPEN_FLOOR);
    expect(item!.question.wording_sha256).toMatch(/^[0-9a-f]{64}$/);
    // 12 Yes + 10 No (Public) + 4 No (Anon, four people under one placeholder user_id) = 26; Private ignored.
    expect(item!.overall.n).toBe(26);
    expect(item!.overall.distribution).toEqual([
      { label: 'Yes', count: 12, pct: 46 },
      { label: 'No', count: 14, pct: 54 },
    ]);
    // 4 Anon is under the floor, and Public would give it away as n - Public.
    expect(item!.overall.tiers).toEqual({ public: null, anon: null });
  });

  it('a wave under the floor publishes its n and provenance only', async () => {
    const item = await getOpenItem(env.DB, 'q-open', ORIGIN);
    expect(item!.waves).toHaveLength(1);
    expect(item!.waves[0]).toMatchObject({
      id: 'w-1', gate: 'world_id', verified_humans: true, is_closed: true, n: 6, below_floor: true, distribution: [],
    });
  });

  it('refuses small, help-request and text questions', async () => {
    expect(await getOpenItem(env.DB, 'q-small', ORIGIN)).toBeNull();
    expect(await getOpenItem(env.DB, 'q-help', ORIGIN)).toBeNull();
    expect(await getOpenItem(env.DB, 'q-text', ORIGIN)).toBeNull();
  });

  it('the index lists only releasable questions', async () => {
    const { items, next } = await listOpenItems(env.DB, ORIGIN);
    expect(items.map((i) => [i.id, i.n])).toEqual([['q-open', 26], ['q-scale', 13]]);
    expect(items[0].url).toBe(`${ORIGIN}/api/open/items/q-open.json`);
    expect(next).toBeNull();
    const paged = await listOpenItems(env.DB, ORIGIN, { limit: 1 });
    expect(paged.next).toBe('q-open');
    expect((await listOpenItems(env.DB, ORIGIN, { after: paged.next })).items.map((i) => i.id)).toEqual(['q-scale']);
  });

  it('CSV carries one row per (scope, label), blanks for withheld cells', async () => {
    const csv = openItemCsv((await getOpenItem(env.DB, 'q-open', ORIGIN))!).trim().split('\n');
    expect(csv[0]).toBe('question_id,scope,wave_id,wave_closed,verified_humans,n,label,count,pct');
    expect(csv).toContain('q-open,overall,,,,26,Yes,12,46');
    expect(csv).toContain('q-open,wave,w-1,true,true,6,,,');
    // Scale: 3 people on 5 is withheld, and 4 goes with it (the two sum to n).
    const scale = openItemCsv((await getOpenItem(env.DB, 'q-scale', ORIGIN))!).trim().split('\n');
    expect(scale.slice(1)).toEqual(['q-scale,overall,,,,13,4,,', 'q-scale,overall,,,,13,5,,']);
  });

  it('the live scale histogram counts every Anon person, not one', async () => {
    const live = await getAggregateResults(env.DB, 'q-scale');
    expect(live!.total).toBe(13);
    expect(live!.distribution.map((r) => [r.label, r.count])).toEqual([['4', 10], ['5', 3]]);
  });
});
