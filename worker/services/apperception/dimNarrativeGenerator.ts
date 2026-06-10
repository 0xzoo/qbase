// apperception — per-dimension narrative generator.
//
// Calls Claude to write a {summary, blindSpot} pair for each of the 3 dims,
// referencing the user's actual scores + strongest likert/forced contributions.
// Runs lazily when the $QQ gate is open (phase-2 fetch after the free tier
// paints). Cached on the session blob so the LLM call only runs once.
//
// Fallback contract: returns null on any failure. Caller falls back to the
// static styleNarratives in scoring.ts so the page still renders.

import {
  LIKERT_ANSWER_WEIGHTS,
  LIKERT_LABELS,
  apperceptionQuestions,
  type ApperceptionAxis,
} from './questions';
import type { ApperceptionAnswer, ApperceptionScore } from './scoring';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

export type DimNarrative = { summary: string; blindSpot: string };
export type DimNarratives = Record<ApperceptionAxis, DimNarrative>;

// Bump whenever the prompt/model changes so cached narratives from older
// versions get regenerated. Saved on the session as `dimNarrativesVersion`.
export const DIM_NARRATIVES_VERSION = 1;

const DIMS: readonly ApperceptionAxis[] = ['concrete', 'reflective', 'sequential'];

const DIM_DESCRIPTIONS: Record<ApperceptionAxis, string> = {
  concrete: 'example-first vs principle-first — learning from concrete examples vs abstract frameworks',
  reflective: 'think-before-acting vs learn-by-doing — planning vs experimentation',
  sequential: 'step-by-step vs big-picture-first — linear process vs systems-level understanding',
};

interface SignatureHit {
  dim: ApperceptionAxis;
  rendered: string;
  mag: number;
}

// Top contributions per dim, signed — positive pushed toward high pole,
// negative toward low pole. Two strongest per dim caps prompt size.
function collectSignatures(answers: ApperceptionAnswer[]): SignatureHit[] {
  const byId = new Map(apperceptionQuestions.map((q) => [q.id, q]));
  const byDim: Record<ApperceptionAxis, SignatureHit[]> = {
    concrete: [], reflective: [], sequential: [],
  };

  for (const ans of answers) {
    const q = byId.get(ans.questionId);
    if (!q) continue;
    if (q.type === 'likert' && ans.type === 'likert') {
      const aw = LIKERT_ANSWER_WEIGHTS[ans.position];
      if (aw === undefined) continue;
      const label = LIKERT_LABELS[ans.position];
      for (const dim of DIMS) {
        const w = q.weights[dim];
        if (typeof w !== 'number') continue;
        const contrib = aw * w;
        if (contrib === 0) continue;
        byDim[dim].push({
          dim,
          rendered: `${label} on "${q.stem}"`,
          mag: contrib,
        });
      }
    } else if (q.type === 'forced' && ans.type === 'forced') {
      const opt = q.a_options[ans.optionIndex];
      if (!opt) continue;
      for (const dim of DIMS) {
        const w = opt.weights[dim];
        if (typeof w !== 'number' || w === 0) continue;
        byDim[dim].push({
          dim,
          rendered: `picked "${opt.label}" on "${q.stem}"`,
          mag: w,
        });
      }
    }
  }

  const out: SignatureHit[] = [];
  for (const dim of DIMS) {
    const top = byDim[dim]
      .slice()
      .sort((a, b) => Math.abs(b.mag) - Math.abs(a.mag))
      .slice(0, 2);
    out.push(...top);
  }
  return out;
}

export function buildDimNarrativePrompt(
  scores: ApperceptionScore,
  answers: ApperceptionAnswer[],
): string {
  const signatures = collectSignatures(answers);

  const scoreBlock = DIMS.map(
    (d) => `- ${d} (${DIM_DESCRIPTIONS[d]}): ${scores[d].toFixed(2)}`,
  ).join('\n');

  const sigsByDim = DIMS.map((d) => {
    const hits = signatures.filter((s) => s.dim === d);
    if (hits.length === 0) return `- ${d}: (no strong contributions)`;
    return `- ${d}:\n${hits
      .map((h) => `    · ${h.mag > 0 ? '+' : '−'} ${h.rendered}`)
      .join('\n')}`;
  }).join('\n');

  return `You are writing a cognitive style reading for one specific human, drawing on the data below. They took a 21-question quiz about how they process new information; the scores and their forced-choice + likert decisions are all here.

Output: a 3-4 sentence "summary" and a 1-sentence "blindSpot" for each of the 3 dimensions, in second person. The reader should be able to tell, within two sentences, that this was written about THEM and not a templated horoscope.

Hard requirements:
1. In each summary, name the specific forced-choice option they picked, or reference a specific tension between two of their scores. Generic statements about the dimension as a concept are forbidden.
2. The blindSpot should be sharp and a little uncomfortable — the kind of thing a friend who's been paying attention would say, not what a personality test would.
3. Match register to the score. High (0.7+): assertive and direct. Low (≤0.3): describe what they're NOT, not what they are. Middling (0.4–0.6): name the ambivalence specifically; don't waffle.
4. Lowercase prose. No bullets, no headers in the output, no "you might" / "you may tend to" hedging.
5. The quiz has no open-text questions — lean entirely on the forced-choice and likert evidence.

Dimension scores (0.0–1.0, 0.5 is neutral):
${scoreBlock}

Strongest per-dim contributions (+ = decisions that pushed this dim higher, − = decisions that pulled it down):
${sigsByDim}

Return JSON only, no prose before or after, with exactly these 3 keys, each an object with "summary" and "blindSpot":
{
  "concrete":    {"summary": "...", "blindSpot": "..."},
  "reflective":  {"summary": "...", "blindSpot": "..."},
  "sequential":  {"summary": "...", "blindSpot": "..."}
}`;
}

export function parseDimNarrativeResponse(raw: unknown): DimNarratives | null {
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

  const out: Partial<DimNarratives> = {};
  for (const d of DIMS) {
    const v = obj[d];
    if (!v || typeof v !== 'object') return null;
    const o = v as Record<string, unknown>;
    const summary = typeof o.summary === 'string' ? o.summary.trim() : '';
    const blindSpot = typeof o.blindSpot === 'string' ? o.blindSpot.trim() : '';
    if (!summary || !blindSpot) return null;
    out[d] = { summary, blindSpot };
  }
  return out as DimNarratives;
}

export interface GenerateResult {
  narratives: DimNarratives | null;
  error?: string;
}

function extractText(response: Record<string, unknown>): string | null {
  // OpenAI-compat: { choices: [{ message: { content } }] }
  const choices = response.choices as
    | Array<{ message?: { content?: unknown }; text?: unknown }>
    | undefined;
  if (Array.isArray(choices) && choices[0]) {
    const c = choices[0];
    if (typeof c.message?.content === 'string') return c.message.content;
    if (typeof c.text === 'string') return c.text;
  }
  // Llama-style: { response: "..." }
  if (typeof response.response === 'string') return response.response;
  // Wrapped: { result: { response: "..." } }
  const result = response.result as { response?: unknown } | undefined;
  if (result && typeof result.response === 'string') return result.response;
  // Some models: { output: "..." } or { generated_text: "..." }
  if (typeof response.output === 'string') return response.output;
  if (typeof response.generated_text === 'string') return response.generated_text;
  return null;
}

export async function generateDimNarratives(
  env: Env,
  scores: ApperceptionScore,
  answers: ApperceptionAnswer[],
): Promise<GenerateResult> {
  const apiKey = (env as { OPENROUTER_API_KEY?: string }).OPENROUTER_API_KEY;
  if (!apiKey) {
    return { narratives: null, error: 'OPENROUTER_API_KEY not bound' };
  }

  const prompt = buildDimNarrativePrompt(scores, answers);
  const model = 'anthropic/claude-haiku-4.5';

  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://qbase.tech',
        'X-Title': 'qbase apperception quiz',
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content:
              'You write personalized cognitive style readings. You only output valid JSON matching the schema requested by the user — no prose before or after.',
          },
          { role: 'user', content: prompt },
        ],
        max_tokens: 1800,
        temperature: 0.7,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const msg = `openrouter ${res.status}: ${body.slice(0, 200)}`;
      console.error(`[apperception dimNarrative] ${msg}`);
      return { narratives: null, error: msg };
    }

    const response = (await res.json()) as Record<string, unknown>;
    const raw = extractText(response);
    if (raw === undefined || raw === null) {
      return {
        narratives: null,
        error: `no text in response. shape: ${JSON.stringify(response).slice(0, 300)}`,
      };
    }

    const narratives = parseDimNarrativeResponse(raw);
    if (!narratives) {
      const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
      console.error(
        `[apperception dimNarrative] parse failed (len=${text.length}): ${text.slice(0, 800)}…${text.slice(-200)}`,
      );
      const looksTruncated = !text.trimEnd().endsWith('}');
      return {
        narratives: null,
        error: looksTruncated
          ? 'response truncated before JSON closed (raise max_tokens)'
          : 'failed to parse JSON from response',
      };
    }
    return { narratives };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[apperception dimNarrative] openrouter call failed:', msg);
    return { narratives: null, error: msg };
  }
}
