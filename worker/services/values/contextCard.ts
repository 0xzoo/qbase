// values — context card composer. Pure function.
//
// Produces a markdown artifact the user can paste into an LLM context window
// or serve via their own MCP / personal-data server. Shape:
//
//   1. YAML frontmatter (machine-readable: scores, dims, generated_at)
//   2. Summary paragraph (dominant + secondary)
//   3. Per-dimension breakdown (summary + blind-spot, ranked by score)
//   4. Signature answers (3 strongest contributions to the dominant dim)
//   5. Reflections (user's verbatim open-text answers)
//
// Gated content; backend-only generation. The /api/values/export route
// re-checks the $QQ gate at request time before calling this — see SPEC §6.

import { valuesQuestions, type ValuesAxis } from './questions';
import type { ValuesAnswer, ValuesFreeTierResult } from './scoring';
import { dimNarratives } from './scoring';

const DIM_LABEL: Record<ValuesAxis, string> = {
  autonomy: 'autonomy',
  care: 'care',
  openness: 'openness',
  mastery: 'mastery',
  universalism: 'universalism',
};

const DIMS: readonly ValuesAxis[] = [
  'autonomy', 'care', 'openness', 'mastery', 'universalism',
];

export interface ContextCardOpts {
  result: ValuesFreeTierResult;
  answers: ValuesAnswer[];
  generatedAt?: Date;
}

export function buildContextCardMarkdown(opts: ContextCardOpts): string {
  const { result, answers } = opts;
  const generatedAt = (opts.generatedAt ?? new Date()).toISOString();

  // Rank dims by score desc; dominant is index 0 by definition.
  const ranked = [...DIMS].sort((a, b) => result.scores[b] - result.scores[a]);

  const fmtScore = (n: number) => n.toFixed(2);

  // ── Frontmatter ──────────────────────────────────────────────────────
  const frontmatter = [
    '---',
    'quiz: values',
    `generated_at: ${generatedAt}`,
    `dominant: ${result.dominant}`,
    `secondary: ${result.secondary}`,
    `confidence: ${fmtScore(result.scores.confidence)}`,
    'scores:',
    ...DIMS.map((d) => `  ${d}: ${fmtScore(result.scores[d])}`),
    '---',
    '',
  ];

  // ── Summary ──────────────────────────────────────────────────────────
  const summary = [
    '# values — context card',
    '',
    `i'm ${DIM_LABEL[result.dominant]}-led. ${dimNarratives[result.dominant].summary}`,
    '',
    `my secondary dimension is ${DIM_LABEL[result.secondary]}.`,
    '',
  ];

  // ── Per-dimension breakdown ──────────────────────────────────────────
  const breakdown: string[] = ['## per-dimension breakdown', ''];
  for (const d of ranked) {
    breakdown.push(`### ${DIM_LABEL[d]} — ${fmtScore(result.scores[d])}`);
    breakdown.push('');
    breakdown.push(dimNarratives[d].summary);
    breakdown.push('');
    breakdown.push(`**blind spot:** ${dimNarratives[d].blindSpot}`);
    breakdown.push('');
  }

  // ── Signature answers ────────────────────────────────────────────────
  const signatures: string[] = [];
  if (result.signatureAnswers.length > 0) {
    signatures.push('## signature answers', '');
    for (const s of result.signatureAnswers) {
      signatures.push(`- ${s}`);
    }
    signatures.push('');
  }

  // ── Reflections (user's verbatim open-text answers) ──────────────────
  const reflections: string[] = [];
  const byId = new Map(valuesQuestions.map((q) => [q.id, q]));
  const openAnswers = answers.filter(
    (a): a is Extract<ValuesAnswer, { type: 'open' }> =>
      a.type === 'open' && typeof a.text === 'string' && a.text.trim().length > 0,
  );
  if (openAnswers.length > 0) {
    reflections.push('## reflections', '');
    for (const a of openAnswers) {
      const q = byId.get(a.questionId);
      if (!q) continue;
      reflections.push(`**${q.stem}**`);
      reflections.push('');
      // Block-quote the user's answer; preserve internal line breaks.
      const lines = a.text.split('\n');
      for (const ln of lines) reflections.push(`> ${ln}`);
      reflections.push('');
    }
  }

  return [...frontmatter, ...summary, ...breakdown, ...signatures, ...reflections]
    .join('\n')
    .trimEnd() + '\n';
}
