/**
 * Tests for the values context-card markdown composer.
 *
 * Asserts on the *shape* of the output (frontmatter keys, section headers,
 * presence of per-dim breakdown + signatures + reflections) rather than
 * exact prose, so authoring tweaks to dim narratives don't break tests.
 */

import { describe, it, expect } from 'vitest';
import { buildContextCardMarkdown } from '../../../worker/services/values/contextCard';
import { freeTierResult, type ValuesAnswer } from '../../../worker/services/values/scoring';
import { valuesQuestions, LIKERT_ANSWER_WEIGHTS } from '../../../worker/services/values/questions';

// Build a "pure autonomy" answer pattern (matches scoring.test.ts helper).
function pureAutonomy(): ValuesAnswer[] {
  const out: ValuesAnswer[] = [];
  for (const q of valuesQuestions) {
    if (q.type === 'likert') {
      const w = q.weights.autonomy ?? 0;
      out.push({
        questionId: q.id,
        type: 'likert',
        position: w > 0 ? 4 : w < 0 ? 0 : 2,
      });
    } else if (q.type === 'forced') {
      const w0 = q.a_options[0].weights.autonomy ?? 0;
      const w1 = q.a_options[1].weights.autonomy ?? 0;
      out.push({ questionId: q.id, type: 'forced', optionIndex: w0 >= w1 ? 0 : 1 });
    } else {
      // Open-text: include answers for some, leave one empty to confirm
      // the composer skips empties.
      const text = q.id === 'q_values_fix_world' ? '' : `my answer to ${q.stem}`;
      out.push({ questionId: q.id, type: 'open', text });
    }
  }
  return out;
}

describe('buildContextCardMarkdown', () => {
  it('produces frontmatter with all 5 dim scores', () => {
    const answers = pureAutonomy();
    const md = buildContextCardMarkdown({
      result: freeTierResult(answers),
      answers,
      generatedAt: new Date('2026-05-10T12:00:00Z'),
    });

    expect(md.startsWith('---\n')).toBe(true);
    expect(md).toContain('quiz: values');
    expect(md).toContain('generated_at: 2026-05-10T12:00:00');
    expect(md).toContain('dominant: autonomy');
    expect(md).toMatch(/scores:\n {2}autonomy: \d\.\d{2}/);
    for (const d of ['autonomy', 'care', 'openness', 'mastery', 'universalism']) {
      expect(md).toMatch(new RegExp(`  ${d}: \\d\\.\\d{2}`));
    }
  });

  it('emits the main sections', () => {
    const answers = pureAutonomy();
    const md = buildContextCardMarkdown({ result: freeTierResult(answers), answers });
    expect(md).toContain('# values — context card');
    expect(md).toContain('## per-dimension breakdown');
    expect(md).toContain('## signature answers');
    expect(md).toContain('## reflections');
  });

  it('includes a per-dimension card for every dim', () => {
    const answers = pureAutonomy();
    const md = buildContextCardMarkdown({ result: freeTierResult(answers), answers });
    for (const d of ['autonomy', 'care', 'openness', 'mastery', 'universalism']) {
      expect(md).toContain(`### ${d}`);
    }
    // Blind spot label should appear 5 times (one per dim).
    const blindSpotMatches = md.match(/\*\*blind spot:\*\*/g) ?? [];
    expect(blindSpotMatches.length).toBe(5);
  });

  it('block-quotes user open-text answers and skips empty ones', () => {
    const answers = pureAutonomy();
    const md = buildContextCardMarkdown({ result: freeTierResult(answers), answers });
    // Two of the three open-text answers should appear (q_values_fix_world is
    // empty in our fixture and should be skipped).
    expect(md).toContain('> my answer to');
    // Exactly two reflection entries — count blockquote first lines.
    const quoteMatches = md.match(/\n> my answer to/g) ?? [];
    expect(quoteMatches.length).toBe(2);
  });

  it('skips the reflections section entirely when no open answers are populated', () => {
    const answers: ValuesAnswer[] = valuesQuestions.map((q) => {
      if (q.type === 'likert') {
        return { questionId: q.id, type: 'likert', position: 2 };
      }
      if (q.type === 'forced') {
        return { questionId: q.id, type: 'forced', optionIndex: 0 };
      }
      return { questionId: q.id, type: 'open', text: '' };
    });
    const md = buildContextCardMarkdown({ result: freeTierResult(answers), answers });
    expect(md).not.toContain('## reflections');
  });

  it('orders per-dim breakdown by score desc', () => {
    const answers = pureAutonomy();
    const md = buildContextCardMarkdown({ result: freeTierResult(answers), answers });

    const autonomyIdx = md.indexOf('### autonomy');
    const otherIdx = ['care', 'openness', 'mastery', 'universalism']
      .map((d) => md.indexOf(`### ${d}`));
    // Autonomy is the dominant — should be the first per-dim card.
    for (const idx of otherIdx) {
      expect(autonomyIdx).toBeLessThan(idx);
    }
  });

  it('LIKERT_ANSWER_WEIGHTS is exported correctly (sanity import)', () => {
    // Smoke test — confirms the questions module is wired up so test
    // failures here indicate a deeper module import issue, not a composer
    // bug.
    expect(LIKERT_ANSWER_WEIGHTS).toEqual([-2, -1, 0, 1, 2]);
  });
});
