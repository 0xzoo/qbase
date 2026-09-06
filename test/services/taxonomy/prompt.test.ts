/**
 * Prompt construction + response normalization for the five-axis classifier.
 * The LLM call itself (classifyWithOpenRouter) is exercised by
 * scripts/taxonomy-gate.ts against the real model; here we pin the pure
 * pieces where format drift bugs live.
 */

import { describe, it, expect } from 'vitest';
import {
  buildClassifierPrompt, extractJsonObject, normalizeClassification, TAXONOMY_VERSION,
} from '../../../worker/services/taxonomy/prompt';
import { classifyWithOpenRouter } from '../../../worker/services/taxonomy/haikuClassifier';

const GOOD_REPLY = {
  is_question: true,
  referent: 'self', mode: 'report', tense: 'present', volatility: 'volatile', intent: 'measure',
  frame: [],
  construction_type: 'complete',
  content_tags: ['emotional', 'not_a_tag'],
  topics: ['Mood', 'mental health', 'x', 'y'],
  temporal_markers: ['rn'],
  sensitivity: 'medium',
  safety_flag: false,
  rationale: { referent: 'about the answerer', mode: 'only they can say', tense: 'now', volatility: 'changes hourly', intent: 'a poll' },
};

describe('buildClassifierPrompt', () => {
  it('embeds the stem, options, and date', () => {
    const p = buildClassifierPrompt('Right now, would you prefer:', ['coffee', 'tea'], new Date('2026-09-07T00:00:00Z'));
    expect(p).toContain('"Right now, would you prefer:"');
    expect(p).toContain('Options: "coffee", "tea"');
    expect(p).toContain('Current date: September 2026');
  });
  it('names all five axes and the JSON keys', () => {
    const p = buildClassifierPrompt('x?');
    for (const k of ['referent', 'mode', 'tense', 'volatility', 'intent', 'is_question', 'rationale', 'frame']) {
      expect(p).toContain(`"${k}"`);
    }
    expect(p).toContain('No options provided');
  });
});

describe('extractJsonObject', () => {
  it('parses a bare object', () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
  });
  it('pulls the object out of surrounding prose / fences', () => {
    expect(extractJsonObject('Sure:\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it('passes through an already-parsed object', () => {
    expect(extractJsonObject({ a: 1 })).toEqual({ a: 1 });
  });
  it('returns null for garbage', () => {
    expect(extractJsonObject('nope')).toBeNull();
    expect(extractJsonObject('{not json}')).toBeNull();
    expect(extractJsonObject(42)).toBeNull();
  });
});

describe('normalizeClassification', () => {
  it('derives the labels and stamps provenance', () => {
    const t = normalizeClassification(GOOD_REPLY, 'how are you feeling rn?', 'test-model');
    expect(t.primary_type).toBe('recurring');
    expect(t.resolvability).toBe('self_only');
    expect(t.signal).toBe('time_series');
    expect(t.wave_relevance).toBe(true);
    expect(t.clout_eligible).toBe(false);
    expect(t.taxonomy_version).toBe(TAXONOMY_VERSION);
    expect(t.classifier).toBe('test-model');
    expect(t.classified_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(t).toMatchObject({ referent: 'self', mode: 'report', tense: 'present', volatility: 'volatile', intent: 'measure' });
  });
  it('filters facets to their enums and caps topics at 3', () => {
    const t = normalizeClassification(GOOD_REPLY, 'how are you feeling rn?', 'm');
    expect(t.content_tags).toEqual(['emotional']);
    expect(t.topics).toEqual(['mood', 'mental health', 'x']);
    expect(t.sensitivity).toBe('medium');
    expect(t.temporal_markers).toEqual(['rn']);
    expect(t.reasoning).toContain('mode: only they can say');
  });
  it('empties content_tags for claims', () => {
    const t = normalizeClassification({ ...GOOD_REPLY, mode: 'claim', tense: 'future', content_tags: ['belief'] }, 'will it rain?', 'm');
    expect(t.primary_type).toBe('predictive');
    expect(t.content_tags).toEqual([]);
  });
  it('trailing colon forces template', () => {
    const t = normalizeClassification({ ...GOOD_REPLY, construction_type: 'complete' }, 'Would you rather:', 'm');
    expect(t.construction_type).toBe('template');
    expect(t.is_template).toBe(true);
  });
  it('fills temporal markers heuristically when the model returns none', () => {
    const t = normalizeClassification({ ...GOOD_REPLY, temporal_markers: [] }, "What's your current stress level today?", 'm');
    expect(t.temporal_markers).toEqual(expect.arrayContaining(['today', 'current']));
  });
  it('"rn" marker needs a word boundary', () => {
    const t = normalizeClassification({ ...GOOD_REPLY, temporal_markers: [] }, 'Which corner store is best?', 'm');
    expect(t.temporal_markers).not.toContain('rn');
  });
  it('is_question:false → invalid', () => {
    const t = normalizeClassification({ ...GOOD_REPLY, is_question: false }, 'asdf', 'm');
    expect(t.primary_type).toBe('invalid');
    expect(t.mode).toBeUndefined();
  });
  it('unparseable axes → invalid, never a derived guess', () => {
    const t = normalizeClassification({ ...GOOD_REPLY, mode: 'opinion' }, 'x?', 'm');
    expect(t.primary_type).toBe('invalid');
    expect(t.reasoning).toBeTruthy();
  });
  it('keeps frame flags', () => {
    const t = normalizeClassification({ ...GOOD_REPLY, mode: 'stance', tense: 'timeless', volatility: 'stable', frame: ['Comparative', 'bogus'] }, "what's the best editor?", 'm');
    expect(t.frame).toEqual(['comparative']);
    expect(t.primary_type).toBe('identity');
  });
});

describe('classifyWithOpenRouter (fetch stubbed)', () => {
  const okFetch = (content: unknown): typeof fetch => (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }] }), { status: 200 })
  ) as unknown as typeof fetch;

  it('sends the prompt to OpenRouter and normalizes the reply', async () => {
    let captured: { url: string; body: Record<string, unknown> } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      captured = { url, body: JSON.parse(String(init.body)) };
      return okFetch(GOOD_REPLY)(url, init);
    }) as unknown as typeof fetch;
    const t = await classifyWithOpenRouter('key', 'how are you feeling rn?', undefined, { fetchImpl });
    expect(t.primary_type).toBe('recurring');
    expect(t.classifier).toBe('anthropic/claude-haiku-4.5');
    expect(captured!.url).toContain('openrouter.ai');
    expect(captured!.body.model).toBe('anthropic/claude-haiku-4.5');
    expect(captured!.body.temperature).toBe(0);
  });
  it('throws on HTTP errors so the caller can fall back', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    await expect(classifyWithOpenRouter('key', 'x?', undefined, { fetchImpl })).rejects.toThrow(/openrouter 500/);
  });
  it('throws when the reply is not JSON', async () => {
    await expect(classifyWithOpenRouter('key', 'x?', undefined, { fetchImpl: okFetch('I cannot classify that.') })).rejects.toThrow(/not JSON/);
  });
});
