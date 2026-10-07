/**
 * Personal MCP core (worker/services/personal/context.ts, select.ts): grouping
 * by typology, the grant's ceiling / domains / disclosure, history as changes
 * of mind, stale volatile state, and parsing the selector's reply.
 */

import { describe, it, expect } from 'vitest';
import {
  buildContext, candidatesOf, embedText, groupOf, measuredFor, positionsOf, scaleLabel, withinCeiling,
  type Grant, type OwnerRecord, type RecordAnswer,
} from '../../worker/services/personal/context';
import { parseSelection } from '../../worker/services/personal/select';

const NOW = Date.parse('2026-10-07T00:00:00Z');
const day = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

function ans(p: Partial<RecordAnswer> & Pick<RecordAnswer, 'id' | 'q_id'>): RecordAnswer {
  return {
    stem: `stem ${p.q_id}`, question_type: 'text', options: null, scale_config: null, value: 'v', reasoning: null,
    audience: 'Public', created_at: day(1), poll_id: null, source: 'feed',
    taxonomy: { mode: 'stance', referent: 'world', volatility: 'stable', primary_type: 'identity', topics: ['politics'] },
    ...p,
  };
}

const record: OwnerRecord = {
  answers: [
    ans({ id: 'a1', q_id: 'q-vote', value: 'yes', created_at: day(30) }),
    ans({ id: 'a2', q_id: 'q-vote', value: 'no', created_at: day(10) }),
    ans({ id: 'a3', q_id: 'q-vote', value: 'no', created_at: day(5) }),
    ans({ id: 's1', q_id: 'q-secret', audience: 'Private', value: 'hidden', taxonomy: { mode: 'stance', referent: 'self', content_tags: ['preference'], topics: ['food'] } }),
    ans({ id: 'n1', q_id: 'q-anon', audience: 'Anon', value: 'masked' }),
    ans({ id: 'm1', q_id: 'q-mood', created_at: day(40), taxonomy: { mode: 'report', referent: 'self', volatility: 'volatile', topics: ['mood'] } }),
    ans({ id: 'f1', q_id: 'q-city', value: 'tokyo', taxonomy: { mode: 'report', referent: 'self', volatility: 'stable', topics: ['location'] } }),
    ans({ id: 'f0', q_id: 'q-city', value: 'berlin', created_at: day(200), taxonomy: { mode: 'report', referent: 'self', volatility: 'stable', topics: ['location'] } }),
    ans({ id: 'g1', q_id: 'q-goal', taxonomy: { mode: 'report', primary_type: 'prospective', topics: ['goals'] } }),
    ans({ id: 'c1', q_id: 'q-scale', question_type: 'scale', value: '4', scale_config: { min: 1, max: 5, customLabels: [{ value: 4, label: 'agree' }] } }),
  ],
  authored: [
    { id: 'q-vote', stem: 'should we vote?', created_at: day(40), taxonomy: null },
    { id: 'q-asked', stem: 'what is a good ballot measure?', created_at: day(3), taxonomy: null },
  ],
  measured: [
    { quiz_id: 'values', completed_at: day(100), result: 'autonomy', scores: { autonomy: 0.8 }, visibility: 'private' },
    { quiz_id: 'bartlet', completed_at: day(90), result: 'Host', scores: null, visibility: 'public' },
  ],
};

const grant = (g: Partial<Grant> = {}): Grant => ({ id: 'g', disclosure: 'raw', ceiling: 'Secret', domains: '*', ...g });

describe('typology → group', () => {
  it('maps the axes', () => {
    expect(groupOf({ primary_type: 'prospective', mode: 'report' })).toBe('goals');
    expect(groupOf({ mode: 'claim' })).toBe('beliefs');
    expect(groupOf({ mode: 'report', volatility: 'volatile' })).toBe('recent');
    expect(groupOf({ mode: 'report', volatility: 'stable' })).toBe('facts');
    expect(groupOf({ mode: 'stance', referent: 'self', content_tags: ['preference'] })).toBe('preferences');
    expect(groupOf({ mode: 'stance', referent: 'world' })).toBe('values');
    expect(groupOf({ primary_type: 'recurring' })).toBe('recent');
    expect(groupOf(null)).toBe('other');
  });
});

describe('ceiling', () => {
  it('orders Public < Anon < Secret; Allowlist counts as Secret', () => {
    expect(withinCeiling('Public', 'Public')).toBe(true);
    expect(withinCeiling('Anon', 'Public')).toBe(false);
    expect(withinCeiling('Anon', 'Anon')).toBe(true);
    expect(withinCeiling('Private', 'Anon')).toBe(false);
    expect(withinCeiling('Allowlist', 'Anon')).toBe(false);
    expect(withinCeiling('Allowlist', 'Secret')).toBe(true);
  });
});

describe('positionsOf', () => {
  it('keeps the latest per question, history only for changes of mind', () => {
    const { positions } = positionsOf(record, grant(), NOW);
    const vote = positions.find((p) => p.question_id === 'q-vote')!;
    expect(vote.answer).toBe('no');
    expect(vote.earlier).toBe(2);
    // a3 'no' → a2 'no' is a repeat, a1 'yes' is the change.
    expect(vote.history).toEqual([{ answer: 'yes', at: day(30) }]);
  });

  it('gives facts their latest value and a count, no history', () => {
    const city = positionsOf(record, grant(), NOW).positions.find((p) => p.question_id === 'q-city')!;
    expect(city.group).toBe('facts');
    expect(city.answer).toBe('tokyo');
    expect(city.earlier).toBe(1);
    expect(city.history).toBeUndefined();
  });

  it('drops stale volatile state unless asked to keep it', () => {
    const { positions, stale } = positionsOf(record, grant(), NOW);
    expect(positions.some((p) => p.question_id === 'q-mood')).toBe(false);
    expect(stale).toBe(1);
    expect(positionsOf(record, grant(), NOW, { includeStale: true }).positions.some((p) => p.question_id === 'q-mood')).toBe(true);
  });

  it('cuts to the ceiling', () => {
    const ids = (g: Grant) => positionsOf(record, g, NOW).positions.map((p) => p.question_id).sort();
    expect(ids(grant({ ceiling: 'Public' }))).not.toContain('q-anon');
    expect(ids(grant({ ceiling: 'Public' }))).not.toContain('q-secret');
    expect(ids(grant({ ceiling: 'Anon' }))).toContain('q-anon');
    expect(ids(grant({ ceiling: 'Anon' }))).not.toContain('q-secret');
    expect(ids(grant())).toContain('q-secret');
  });

  it('cuts to domains', () => {
    const ids = positionsOf(record, grant({ domains: ['food'] }), NOW).positions.map((p) => p.question_id);
    expect(ids).toEqual(['q-secret']);
  });

  it('labels scale answers', () => {
    const s = positionsOf(record, grant(), NOW).positions.find((p) => p.question_id === 'q-scale')!;
    expect(s.answer).toBe('4');
    expect(s.answer_label).toBe('agree');
    expect(scaleLabel('7', { min: 1, max: 10 })).toBe('7 on 1–10');
  });
});

describe('candidatesOf', () => {
  it('offers stems (with options) within the grant, never answers', () => {
    const r: OwnerRecord = { ...record, answers: [...record.answers, ans({ id: 'o1', q_id: 'q-opt', question_type: 'mc', options: ['a', 'b'], value: 'a' })] };
    const c = candidatesOf(r, grant({ ceiling: 'Public' }), NOW);
    expect(c.find((x) => x.id === 'q-opt')!.text).toBe('stem q-opt (a / b)');
    expect(c.some((x) => x.id === 'q-secret')).toBe(false);
    expect(c.some((x) => x.id === 'q-asked')).toBe(true);
    expect(JSON.stringify(c)).not.toContain('hidden');
    expect(embedText(' plain ', null)).toBe('plain');
  });

  it('never offers a sealed stem, answered or authored, even to the owner\'s Secret key', () => {
    const r: OwnerRecord = {
      ...record,
      answers: [...record.answers, ans({ id: 'z1', q_id: 'q-sealed', stem: 'should I leave Acme?', stem_sealed: true })],
      authored: [...record.authored, { id: 'q-sealed-asked', stem: 'is my cofounder lying?', created_at: day(1), taxonomy: null, stem_sealed: true }],
    };
    const text = JSON.stringify(candidatesOf(r, grant(), NOW));
    expect(text).not.toContain('Acme');
    expect(text).not.toContain('cofounder');
  });
});

describe('measuredFor (consent-model §3.7: derived from Secret is Secret)', () => {
  it('cuts quiz results to the ceiling by completion visibility', () => {
    expect(measuredFor(record, grant({ ceiling: 'Public' })).map((m) => m.quiz_id)).toEqual(['bartlet']);
    expect(measuredFor(record, grant({ ceiling: 'Anon' })).map((m) => m.quiz_id)).toEqual(['bartlet']);
    expect(measuredFor(record, grant()).map((m) => m.quiz_id)).toEqual(['values', 'bartlet']);
  });
  it('gives a domain-scoped grant no quiz results', () => {
    expect(measuredFor(record, grant({ domains: ['food'] }))).toEqual([]);
  });
  it('flows through buildContext', () => {
    const b = buildContext({ decision: 'd', record, grant: grant({ ceiling: 'Public', disclosure: 'derived' }), selected: [], gaps: [], selection: 'model', now: NOW });
    expect(JSON.stringify(b)).not.toContain('autonomy');
  });
});

describe('buildContext', () => {
  const selected = [{ id: 'q-secret', why: 'taste' }, { id: 'q-vote', why: 'civic' }, { id: 'q-asked', why: 'learning' }, { id: 'q-nope', why: 'x' }];

  it('groups selected positions in selection order, asked questions apart', () => {
    const b = buildContext({ decision: 'd', record, grant: grant(), selected, gaps: ['g?'], selection: 'model', now: NOW });
    expect(b.groups!.preferences!.map((p) => [p.question_id, p.why])).toEqual([['q-secret', 'taste']]);
    expect(b.groups!.values!.map((p) => p.question_id)).toEqual(['q-vote']);
    // q-vote is a position, so it is not repeated under asked.
    expect(b.asked!.map((a) => a.question_id)).toEqual(['q-asked']);
    expect(b.coverage.gaps).toEqual(['g?']);
    expect(b.coverage.relevant).toEqual({ preferences: 1, values: 1 });
    expect(b.measured[0].provenance).toBe('measured');
  });

  it('serves no answers under a derived grant', () => {
    const b = buildContext({ decision: 'd', record, grant: grant({ disclosure: 'derived' }), selected, gaps: [], selection: 'model', now: NOW });
    expect(b.groups).toBeUndefined();
    expect(b.asked).toBeUndefined();
    expect(JSON.stringify(b)).not.toContain('hidden');
    expect(b.coverage.relevant).toEqual({ preferences: 1, values: 1 });
  });

  it('never returns a selected question outside the ceiling', () => {
    const b = buildContext({ decision: 'd', record, grant: grant({ ceiling: 'Public' }), selected, gaps: [], selection: 'model', now: NOW });
    expect(JSON.stringify(b)).not.toContain('q-secret');
  });
});

describe('parseSelection', () => {
  const list = [{ id: 'x', text: 'one' }, { id: 'y', text: 'two' }];
  it('maps numbers to ids, drops out-of-range and repeats', () => {
    const s = parseSelection('```json\n{"relevant":[{"n":2,"why":"w"},{"n":9},{"n":2},{"n":1}],"gaps":["a?"," ",3]}\n```', list);
    expect(s.selected).toEqual([{ id: 'y', why: 'w' }, { id: 'x', why: '' }]);
    expect(s.gaps).toEqual(['a?']);
    expect(s.via).toBe('model');
  });
  it('falls back on non-JSON', () => {
    expect(parseSelection('sorry', list).via).toBe('fallback');
  });
});
