/**
 * Authoring review (worker/services/hygiene/questionReview.ts): the model's
 * reply is cleaned to known issue kinds, a suggestion only when it changes
 * something, and any failure is "no issues" so asking never stops.
 */

import { describe, it, expect } from 'vitest';
import { normalizeReview, reviewQuestion, sanitizeHygiene } from '../../worker/services/hygiene/questionReview';

const reply = (content: string, status = 200) => (async () => new Response(
  JSON.stringify({ choices: [{ message: { content } }] }), { status },
)) as unknown as typeof fetch;

describe('question review', () => {
  it('keeps known kinds once each, drops option issues on a text question, and returns the rewrite', () => {
    const r = normalizeReview({
      issues: [
        { kind: 'leading', note: 'Pushes toward yes.' }, { kind: 'leading', note: 'dup' },
        { kind: 'made_up', note: 'x' }, { kind: 'options_overlap', note: 'n/a' },
      ],
      suggestion: { stem: 'How do you feel about the new park?' },
    }, { stem: "Don't you love the new park?", type: 'text' });
    expect(r.issues).toEqual([{ kind: 'leading', note: 'Pushes toward yes.' }]);
    expect(r.suggestion).toEqual({ stem: 'How do you feel about the new park?' });
  });

  it('no issues means no suggestion; an unchanged suggestion is dropped', () => {
    expect(normalizeReview({ issues: [], suggestion: { stem: 'x?' } }, { stem: 'How many hours do you sleep?', type: 'text' }))
      .toEqual({ issues: [], reviewed: 'model' });
    const same = normalizeReview({ issues: [{ kind: 'vague', note: 'v' }], suggestion: { stem: 'Do you use it?' } }, { stem: 'Do you use it?', type: 'text' });
    expect(same.suggestion).toBeUndefined();
  });

  it('a yes/no question with yes/no options is never missing options', () => {
    const r = normalizeReview({ issues: [{ kind: 'options_missing', note: 'add unsure' }] }, { stem: 'Do you believe in god?', type: 'mc', options: ['Yes', 'No'] });
    expect(r.issues).toEqual([]);
  });

  it('a note-only kind next to a real issue keeps the rewrite', () => {
    const r = normalizeReview({
      issues: [{ kind: 'vague', note: 'v' }, { kind: 'time_bound', note: 'Next month moves.' }],
      suggestion: { stem: 'Will you travel in December 2026?' },
    }, { stem: 'Will you travel next month?', type: 'text' });
    expect(r.suggestion).toEqual({ stem: 'Will you travel in December 2026?' });
  });

  it('drops a suggestion with a placeholder in it', () => {
    const r = normalizeReview({ issues: [{ kind: 'vague', note: 'Use what?' }], suggestion: { stem: 'How often do you use [product]?' } }, { stem: 'Do you use it often?', type: 'text' });
    expect(r).toEqual({ issues: [{ kind: 'vague', note: 'Use what?' }], reviewed: 'model' });
  });

  it('rewrites options only when they come back usable', () => {
    const d = { stem: 'How old are you?', type: 'mc', options: ['1-5', '5-10'] };
    const r = normalizeReview({ issues: [{ kind: 'options_overlap', note: 'o' }], suggestion: { stem: 'How old are you?', options: ['under 5', '5 to 10', 'over 10'] } }, d);
    expect(r.suggestion).toEqual({ stem: 'How old are you?', options: ['under 5', '5 to 10', 'over 10'] });
    const bad = normalizeReview({ issues: [{ kind: 'options_overlap', note: 'o' }], suggestion: { stem: 'How old are you?', options: ['one'] } }, d);
    expect(bad.suggestion).toBeUndefined();
  });

  it('fails open: no key, HTTP error, or a reply that isn\'t JSON', async () => {
    const d = { stem: 'Is the city safe and affordable?', type: 'text' };
    expect(await reviewQuestion(undefined, d)).toEqual({ issues: [], reviewed: 'unavailable' });
    expect(await reviewQuestion('k', d, { fetchImpl: reply('{}', 500) })).toEqual({ issues: [], reviewed: 'unavailable' });
    expect(await reviewQuestion('k', d, { fetchImpl: reply('sorry, no') })).toEqual({ issues: [], reviewed: 'unavailable' });
  });

  it('parses a fenced JSON reply', async () => {
    const r = await reviewQuestion('k', { stem: 'Is the city safe and affordable?', type: 'text' }, {
      fetchImpl: reply('```json\n{"issues":[{"kind":"double_barrelled","note":"Two questions."}],"suggestion":{"stem":"Is the city safe?"}}\n```'),
    });
    expect(r).toEqual({ issues: [{ kind: 'double_barrelled', note: 'Two questions.' }], suggestion: { stem: 'Is the city safe?' }, reviewed: 'model' });
  });
});

describe('sanitizeHygiene (what POST /api/queries stores on taxonomy.hygiene)', () => {
  it('keeps known kinds once and a known outcome', () => {
    expect(sanitizeHygiene({ issues: ['leading', 'leading', 'made_up', 7], outcome: 'suggestion' }, 'm'))
      .toEqual({ issues: ['leading'], outcome: 'suggestion', model: 'm' });
  });
  it('stores nothing for a missing or malformed report', () => {
    expect(sanitizeHygiene(undefined, 'm')).toBeNull();
    expect(sanitizeHygiene({ issues: 'leading', outcome: 'clean' }, 'm')).toBeNull();
    expect(sanitizeHygiene({ issues: [], outcome: 'ignored' }, 'm')).toBeNull();
  });
});
