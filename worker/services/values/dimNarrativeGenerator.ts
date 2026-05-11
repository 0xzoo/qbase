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

  return `You are writing a personal-values reading for one specific person. They took a 21-question quiz across 5 dimensions; their results are below. Write a 1-paragraph "summary" and a 1-sentence "blind spot" for each of the 5 dimensions, in second person ("you ..."). Reference the user's actual choices and reflections — generic horoscope language is not useful. Be direct and a little incisive. Lowercase prose, no bullet lists in the output, no hedging like "you may" or "you might tend to" unless the score is genuinely middling.

Dimension scores (0.0–1.0, 0.5 is neutral):
${scoreBlock}

Open-text reflections:
${reflectionsBlock}

Strongest per-dim contributions (+ = pushed toward this dim, − = pushed away):
${sigsByDim}

Return JSON only, no prose before or after, with exactly these 5 keys, each an object with "summary" (3–4 sentences) and "blindSpot" (1 sentence):
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

export async function generateDimNarratives(
  env: Env,
  scores: ValuesScore,
  answers: ValuesAnswer[],
): Promise<DimNarratives | null> {
  const apiKey = (env as { ANTHROPIC_API_KEY?: string }).ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn('[values dimNarrative] ANTHROPIC_API_KEY not bound');
    return null;
  }

  const prompt = buildDimNarrativePrompt(scores, answers);

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      console.error(
        `[values dimNarrative] anthropic ${response.status}: ${errText.slice(0, 200)}`,
      );
      return null;
    }

    const body = (await response.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const text = body.content?.find((c) => c.type === 'text')?.text;
    if (!text) return null;

    return parseDimNarrativeResponse(text);
  } catch (e) {
    console.error('[values dimNarrative] request failed:', e);
    return null;
  }
}
