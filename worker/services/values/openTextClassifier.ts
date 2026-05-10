// values — open-text answer classifier.
//
// Calls Workers AI to score the user's 3 free-text reflections across the 5
// dims, producing scores 0-1 that get blended into the Likert+forced score
// per SPEC §5 (default 0.7 Likert + 0.3 open-text).
//
// First call runs at quiz completion (or first result-page load if missed),
// the result is cached on the session blob so subsequent loads skip the LLM.
// Failure is non-fatal — fall back to Likert-only scoring rather than block
// the result page.

import { valuesQuestions, type ValuesAxis } from './questions';
import type { ValuesAnswer, ValuesScore } from './scoring';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

export type OpenTextScores = Omit<ValuesScore, 'confidence'>;

const DIMS: readonly ValuesAxis[] = [
  'autonomy', 'care', 'openness', 'mastery', 'universalism',
];

const NEUTRAL: OpenTextScores = {
  autonomy: 0.5, care: 0.5, openness: 0.5, mastery: 0.5, universalism: 0.5,
};

const DIM_DESCRIPTIONS: Record<ValuesAxis, string> = {
  autonomy: 'acting on own judgment, independence, self-direction',
  care: "weighting others' welfare, empathy, in-group preservation",
  openness: 'novelty, change, curiosity, comfort with uncertainty',
  mastery: 'competence, craft, becoming better at the thing',
  universalism: 'all-of-humanity outcomes, environment, justice',
};

interface OpenAnswerWithStem {
  stem: string;
  text: string;
}

// Pull non-empty open answers + their question stems. Pure helper, easy
// to unit-test.
export function collectOpenAnswers(answers: ValuesAnswer[]): OpenAnswerWithStem[] {
  const byId = new Map(valuesQuestions.map((q) => [q.id, q]));
  const out: OpenAnswerWithStem[] = [];
  for (const a of answers) {
    if (a.type !== 'open') continue;
    const text = (a.text ?? '').trim();
    if (text.length === 0) continue;
    const q = byId.get(a.questionId);
    if (!q) continue;
    out.push({ stem: q.stem, text });
  }
  return out;
}

// Build the LLM prompt. Pure function for testing.
export function buildClassifierPrompt(items: OpenAnswerWithStem[]): string {
  const dimsBlock = DIMS.map((d) => `- ${d}: ${DIM_DESCRIPTIONS[d]}`).join('\n');
  const answersBlock = items
    .map((it, i) => `${i + 1}. "${it.stem}"\n   answer: ${JSON.stringify(it.text)}`)
    .join('\n');
  return `You are scoring a person's reflective answers across 5 personal-values dimensions. For each dimension, output a number between 0.0 and 1.0 reflecting how strongly the reflections signal that dimension. Use 0.5 as the neutral default — only move significantly when the text gives clear evidence.

Dimensions:
${dimsBlock}

Reflections:
${answersBlock}

Return JSON only, with these exact 5 keys, all values numbers between 0 and 1:
{"autonomy": <num>, "care": <num>, "openness": <num>, "mastery": <num>, "universalism": <num>}`;
}

// Parse the LLM's response. Tolerates extra prose and slight format drift.
// Returns null on unparseable output. Pure function for testing.
export function parseClassifierResponse(raw: unknown): OpenTextScores | null {
  let parsed: unknown;
  if (raw && typeof raw === 'object') {
    parsed = raw;
  } else if (typeof raw === 'string') {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return null;
    }
  } else {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;

  const result: OpenTextScores = { ...NEUTRAL };
  for (const d of DIMS) {
    const v = obj[d];
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n)) return null;
    result[d] = Math.max(0, Math.min(1, n));
  }
  return result;
}

// Run the full classifier. Returns null if there are no scorable answers,
// or if the model call fails. Caller blends into the Likert score, falling
// back to Likert-only when null is returned.
export async function classifyOpenText(
  env: Env,
  answers: ValuesAnswer[],
): Promise<OpenTextScores | null> {
  const items = collectOpenAnswers(answers);
  if (items.length === 0) return null;

  const prompt = buildClassifierPrompt(items);
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ai = (env as any).AI;
    if (!ai) {
      console.warn('[values openText] env.AI not bound');
      return null;
    }
    // 70B fp8-fast: better at nuanced classification than the 3B model that
    // AIService.classifyQuestion uses, while still latency-acceptable in the
    // result-snap completion path. Drop back to 3B if Workers AI quotas
    // become a problem.
    const response: { response?: unknown } = await ai.run(
      '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      {
        messages: [
          {
            role: 'system',
            content:
              'You score reflective answers across personal-values dimensions and output only valid JSON with five numeric keys.',
          },
          { role: 'user', content: prompt },
        ],
        max_tokens: 200,
        temperature: 0.1,
      },
    );
    return parseClassifierResponse(response.response);
  } catch (e) {
    console.error('[values openText] classifier failed:', e);
    return null;
  }
}
