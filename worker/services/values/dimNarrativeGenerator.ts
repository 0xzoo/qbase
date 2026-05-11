// values — per-dimension narrative generator.
//
// Calls Claude to write a {summary, blindSpot} pair for each of the 5 dims,
// referencing the user's actual scores + open-text reflections + strongest
// likert/forced contributions. Runs once per session (cached on the session
// blob), only when the $QQ gate is open — locked users never pay the LLM cost.
//
// Fallback contract: returns null on any failure. Caller falls back to the
// static dimNarratives in scoring.ts so the page still renders.

import {
  LIKERT_ANSWER_WEIGHTS,
  LIKERT_LABELS,
  valuesQuestions,
  type ValuesAxis,
} from './questions';
import type { ValuesAnswer, ValuesScore } from './scoring';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

export type DimNarrative = { summary: string; blindSpot: string };
export type DimNarratives = Record<ValuesAxis, DimNarrative>;

// Bump whenever the prompt/model changes so cached narratives from older
// versions get regenerated. Saved on the session as `dimNarrativesVersion`.
// v3: switched generator from Anthropic to Workers AI (Gemma 4 26b).
export const DIM_NARRATIVES_VERSION = 3;

const DIMS: readonly ValuesAxis[] = [
  'autonomy', 'care', 'openness', 'mastery', 'universalism',
];

const DIM_DESCRIPTIONS: Record<ValuesAxis, string> = {
  autonomy: 'self-direction, independence, acting on own judgment',
  care: "weighting others' welfare, empathy, close-relationship priority",
  openness: 'novelty, curiosity, comfort with uncertainty, change',
  mastery: 'competence, craft, deliberate practice toward expertise',
  universalism: 'fairness for strangers, environment, long-tail consequences',
};

interface OpenReflection {
  stem: string;
  text: string;
}

interface SignatureHit {
  dim: ValuesAxis;
  rendered: string;
  mag: number;
}

function collectOpenReflections(answers: ValuesAnswer[]): OpenReflection[] {
  const byId = new Map(valuesQuestions.map((q) => [q.id, q]));
  const out: OpenReflection[] = [];
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

// Top contributions per dim, signed — positive pushed toward, negative away.
// Two strongest per dim caps prompt size.
function collectSignatures(answers: ValuesAnswer[]): SignatureHit[] {
  const byId = new Map(valuesQuestions.map((q) => [q.id, q]));
  const byDim: Record<ValuesAxis, SignatureHit[]> = {
    autonomy: [], care: [], openness: [], mastery: [], universalism: [],
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
  scores: ValuesScore,
  answers: ValuesAnswer[],
): string {
  const reflections = collectOpenReflections(answers);
  const signatures = collectSignatures(answers);

  const scoreBlock = DIMS.map(
    (d) => `- ${d} (${DIM_DESCRIPTIONS[d]}): ${scores[d].toFixed(2)}`,
  ).join('\n');

  const reflectionsBlock = reflections.length
    ? reflections
        .map(
          (r, i) =>
            `${i + 1}. Q: ${r.stem}\n   A: ${JSON.stringify(r.text)}`,
        )
        .join('\n')
    : '(none provided)';

  const sigsByDim = DIMS.map((d) => {
    const hits = signatures.filter((s) => s.dim === d);
    if (hits.length === 0) return `- ${d}: (no strong contributions)`;
    return `- ${d}:\n${hits
      .map((h) => `    · ${h.mag > 0 ? '+' : '−'} ${h.rendered}`)
      .join('\n')}`;
  }).join('\n');

  return `You are writing a values reading for one specific human, drawing on the data below. They took a 21-question quiz; the scores, their forced-choice + likert decisions, and their open-text reflections are all here.

Output: a 3-4 sentence "summary" and a 1-sentence "blindSpot" for each of the 5 dimensions, in second person. The reader should be able to tell, within two sentences, that this was written about THEM and not a templated horoscope.

Hard requirements:
1. In each summary, do at least one of: (a) quote or near-quote a phrase from their reflections, (b) name the specific forced-choice option they picked, or (c) reference a specific tension between two of their scores. Generic statements about the dimension as a concept are forbidden.
2. The blindSpot should be sharp and a little uncomfortable — the kind of thing a friend who's been paying attention would say, not what a personality test would.
3. Match register to the score. High (0.7+): assertive and direct. Low (≤0.3): describe what they're NOT, not what they are. Middling (0.4–0.6): name the ambivalence specifically; don't waffle.
4. Lowercase prose. No bullets, no headers in the output, no "you might" / "you may tend to" hedging.
5. The reflections are first-person from them. Treat them as primary evidence; quote sparingly but specifically. If a reflection is short or empty, lean on the forced-choice and likert evidence instead — never invent.

Dimension scores (0.0–1.0, 0.5 is neutral):
${scoreBlock}

Their open-text reflections (verbatim):
${reflectionsBlock}

Strongest per-dim contributions (+ = decisions that pushed this dim higher, − = decisions that pulled it down):
${sigsByDim}

Return JSON only, no prose before or after, with exactly these 5 keys, each an object with "summary" and "blindSpot":
{
  "autonomy":     {"summary": "...", "blindSpot": "..."},
  "care":         {"summary": "...", "blindSpot": "..."},
  "openness":     {"summary": "...", "blindSpot": "..."},
  "mastery":      {"summary": "...", "blindSpot": "..."},
  "universalism": {"summary": "...", "blindSpot": "..."}
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

export async function generateDimNarratives(
  env: Env,
  scores: ValuesScore,
  answers: ValuesAnswer[],
): Promise<GenerateResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ai = (env as any).AI;
  if (!ai) {
    return { narratives: null, error: 'env.AI not bound' };
  }

  const prompt = buildDimNarrativePrompt(scores, answers);
  // Gemma 4 26B (≈4B active, MoE) on Workers AI — much lower latency than
  // the 70B llama we were using, while still strong on short instruction-
  // following work. Swap to '@cf/meta/llama-3.3-70b-instruct-fp8-fast' if
  // we ever need to trade latency back for prose quality.
  const model = '@cf/google/gemma-4-26b-a4b-it';

  try {
    const response: { response?: unknown } = await ai.run(model, {
      messages: [
        {
          role: 'system',
          content:
            'You write personalized values readings. You only output valid JSON matching the schema requested by the user — no prose before or after.',
        },
        { role: 'user', content: prompt },
      ],
      max_tokens: 2500,
      temperature: 0.7,
    });

    const raw = response?.response;
    if (raw === undefined || raw === null) {
      return { narratives: null, error: 'empty response from workers ai' };
    }

    const narratives = parseDimNarrativeResponse(raw);
    if (!narratives) {
      const preview = typeof raw === 'string' ? raw.slice(0, 300) : JSON.stringify(raw).slice(0, 300);
      console.error(`[values dimNarrative] parse failed for text: ${preview}`);
      return { narratives: null, error: 'failed to parse JSON from response' };
    }
    return { narratives };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[values dimNarrative] workers ai call failed:', msg);
    return { narratives: null, error: msg };
  }
}
