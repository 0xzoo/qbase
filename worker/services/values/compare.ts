// values — compatibility (docs/quizzes/CONTENT-PLAN.md §7.5, notes in
// docs/quizzes/compatibility/NOTES.md, card t_990220e3).
//
// `compare(profileA, profileB)` over two values completions. Pure functions
// here; the D1 / KV / Farcaster / OpenRouter plumbing lives in
// compareService.ts.
//
//   1. Per-dimension deltas (a − b on the 0..1 scale) and a dim-based
//      alignment figure (1 − mean |delta|).
//   2. Every Likert and forced-choice item both people answered, with a
//      verdict: agree (same side of the scale / same option), disagree
//      (opposite sides / different options), neutral (one of them sat on
//      the fence). Open-text answers never enter a comparison — they are the
//      most personal thing in the quiz and the other person never sees them.
//   3. "Surprising" = the item's verdict runs against what the two profiles
//      predict. An agreement on an item whose dimensions they differ most on
//      is surprising; a disagreement where their dimensions are closest is
//      surprising. Ranked deterministically, top three of each.
//   4. A narrative — headline + one line per surprising item — written by
//      an LLM (OpenRouter, same path as the per-dim narratives) with a
//      templated fallback so the page always renders.

import {
  LIKERT_ANSWER_WEIGHTS,
  LIKERT_LABELS,
  valuesQuestions,
  type ValuesAxis,
} from './questions';
import type { ValuesAnswer, ValuesScore } from './scoring';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

// Bump when the ranking, the prompt or the model changes: the KV-cached
// narratives are keyed by it.
export const COMPARE_VERSION = 1;

export const COMPARE_DIMS: readonly ValuesAxis[] = [
  'autonomy',
  'care',
  'openness',
  'mastery',
  'universalism',
];

export const DIM_LABEL: Record<ValuesAxis, string> = {
  autonomy: 'autonomy',
  care: 'care',
  openness: 'openness',
  mastery: 'mastery',
  universalism: 'universalism',
};

export const SURPRISING_PER_SIDE = 3;

export interface CompareProfile {
  completionId: string;
  fid: number;
  completedAt: number;
  scores: ValuesScore;
  dominant: ValuesAxis;
  secondary: ValuesAxis;
  answers: ValuesAnswer[];
}

export interface DimDelta {
  dim: ValuesAxis;
  a: number;
  b: number;
  /** a − b, on the 0..1 score scale. */
  delta: number;
}

export type ItemVerdict = 'agree' | 'disagree' | 'neutral';

export interface SharedItem {
  questionId: string;
  stem: string;
  type: 'likert' | 'forced';
  /** Human label of each side's answer (Likert label or option text). */
  a: string;
  b: string;
  verdict: ItemVerdict;
  /** Likert: |position_a − position_b| (0..4). Forced: 0 or 1. */
  distance: number;
  /** 0..1, higher = the verdict runs harder against the two profiles. */
  surprise: number;
  dims: ValuesAxis[];
}

export interface Comparison {
  version: number;
  dims: DimDelta[];
  /** 1 − mean |delta| over the five dimensions, 0..1. */
  alignment: number;
  closest: ValuesAxis;
  furthest: ValuesAxis;
  /** Likert + forced items both people answered (open-text excluded). */
  sharedItems: number;
  agreeCount: number;
  disagreeCount: number;
  neutralCount: number;
  agreements: SharedItem[];
  disagreements: SharedItem[];
}

export interface CompareNames {
  a: string;
  b: string;
}

export interface CompareNarrative {
  headline: string;
  agreements: string[];
  disagreements: string[];
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

// Likert position → which side of neutral: −1 disagree, 0 neutral, +1 agree.
function side(position: number): -1 | 0 | 1 {
  if (position <= 1) return -1;
  if (position >= 3) return 1;
  return 0;
}

function indexAnswers(answers: ValuesAnswer[]): Map<string, ValuesAnswer> {
  // Latest answer per question wins (a session that repeated a question
  // carries duplicates; the last one is what the person settled on).
  const m = new Map<string, ValuesAnswer>();
  for (const a of answers) m.set(a.questionId, a);
  return m;
}

export function compareProfiles(a: CompareProfile, b: CompareProfile): Comparison {
  const dims: DimDelta[] = COMPARE_DIMS.map((dim) => ({
    dim,
    a: round3(a.scores[dim]),
    b: round3(b.scores[dim]),
    delta: round3(a.scores[dim] - b.scores[dim]),
  }));
  const absDelta = (d: ValuesAxis) => Math.abs(a.scores[d] - b.scores[d]);
  const alignment = round3(1 - dims.reduce((s, d) => s + Math.abs(d.delta), 0) / dims.length);
  const byCloseness = [...COMPARE_DIMS].sort((x, y) => absDelta(x) - absDelta(y));
  const closest = byCloseness[0];
  const furthest = byCloseness[byCloseness.length - 1];

  const ansA = indexAnswers(a.answers);
  const ansB = indexAnswers(b.answers);

  const items: SharedItem[] = [];
  for (const q of valuesQuestions) {
    if (q.type === 'open') continue;
    const ra = ansA.get(q.id);
    const rb = ansB.get(q.id);
    if (!ra || !rb) continue;

    // How far apart the two profiles are on the dimensions this item probes:
    // the "expected" disagreement, 0..1 (a half-scale gap already reads as
    // a full expectation of disagreement).
    const probeGap = q.probes.length
      ? q.probes.reduce((s, d) => s + absDelta(d), 0) / q.probes.length
      : 0;
    const expected = Math.min(1, probeGap * 2);

    if (q.type === 'likert') {
      if (ra.type !== 'likert' || rb.type !== 'likert') continue;
      const pa = ra.position;
      const pb = rb.position;
      if (LIKERT_ANSWER_WEIGHTS[pa] === undefined || LIKERT_ANSWER_WEIGHTS[pb] === undefined) continue;
      const sa = side(pa);
      const sb = side(pb);
      const verdict: ItemVerdict = sa * sb > 0 ? 'agree' : sa * sb < 0 ? 'disagree' : 'neutral';
      const distance = Math.abs(pa - pb);
      let surprise = 0;
      if (verdict === 'agree') {
        const strength = Math.min(Math.abs(LIKERT_ANSWER_WEIGHTS[pa]), Math.abs(LIKERT_ANSWER_WEIGHTS[pb])) / 2;
        surprise = 0.7 * expected + 0.3 * strength;
      } else if (verdict === 'disagree') {
        surprise = 0.7 * (1 - expected) + 0.3 * (distance / 4);
      }
      items.push({
        questionId: q.id,
        stem: q.stem,
        type: 'likert',
        a: LIKERT_LABELS[pa],
        b: LIKERT_LABELS[pb],
        verdict,
        distance,
        surprise: round3(surprise),
        dims: [...q.probes],
      });
    } else {
      if (ra.type !== 'forced' || rb.type !== 'forced') continue;
      const oa = q.a_options[ra.optionIndex];
      const ob = q.a_options[rb.optionIndex];
      if (!oa || !ob) continue;
      const same = ra.optionIndex === rb.optionIndex;
      const verdict: ItemVerdict = same ? 'agree' : 'disagree';
      const surprise = same ? 0.7 * expected + 0.3 : 0.7 * (1 - expected) + 0.3;
      items.push({
        questionId: q.id,
        stem: q.stem,
        type: 'forced',
        a: oa.label,
        b: ob.label,
        verdict,
        distance: same ? 0 : 1,
        surprise: round3(surprise),
        dims: [...q.probes],
      });
    }
  }

  // Stable: by surprise desc, then bank order (items were pushed in bank order).
  const pick = (verdict: ItemVerdict) =>
    items
      .map((it, i) => ({ it, i }))
      .filter(({ it }) => it.verdict === verdict)
      .sort((x, y) => y.it.surprise - x.it.surprise || x.i - y.i)
      .slice(0, SURPRISING_PER_SIDE)
      .map(({ it }) => it);

  const agreeCount = items.filter((i) => i.verdict === 'agree').length;
  const disagreeCount = items.filter((i) => i.verdict === 'disagree').length;

  return {
    version: COMPARE_VERSION,
    dims,
    alignment,
    closest,
    furthest,
    sharedItems: items.length,
    agreeCount,
    disagreeCount,
    neutralCount: items.length - agreeCount - disagreeCount,
    agreements: pick('agree'),
    disagreements: pick('disagree'),
  };
}

// ─── Narrative ───────────────────────────────────────────────────────────

/** Templated prose, used when the LLM is unavailable or fails. */
export function staticNarrative(cmp: Comparison, names: CompareNames): CompareNarrative {
  const decided = cmp.agreeCount + cmp.disagreeCount;
  const headline = decided === 0
    ? `${names.a} and ${names.b} don't share a decided answer yet.`
    : `${names.a} and ${names.b} match on ${cmp.agreeCount} of ${decided} answers — closest on ${DIM_LABEL[cmp.closest]}, furthest apart on ${DIM_LABEL[cmp.furthest]}.`;

  const line = (it: SharedItem): string => {
    if (it.type === 'forced') {
      return it.verdict === 'agree'
        ? `both picked "${it.a}" when asked "${it.stem}".`
        : `${names.a} picked "${it.a}", ${names.b} picked "${it.b}" — "${it.stem}".`;
    }
    if (it.a === it.b) return `both ${it.a}: "${it.stem}".`;
    return `${names.a}: ${it.a} · ${names.b}: ${it.b} — "${it.stem}".`;
  };

  return {
    headline,
    agreements: cmp.agreements.map(line),
    disagreements: cmp.disagreements.map(line),
  };
}

export function buildComparePrompt(cmp: Comparison, names: CompareNames): string {
  const dimBlock = cmp.dims
    .map((d) => `- ${DIM_LABEL[d.dim]}: ${names.a} ${d.a.toFixed(2)} · ${names.b} ${d.b.toFixed(2)} (gap ${Math.abs(d.delta).toFixed(2)})`)
    .join('\n');

  const itemBlock = (items: SharedItem[]) =>
    items.length
      ? items
          .map((it, i) => {
            const why = it.dims.map((d) => DIM_LABEL[d]).join(' + ');
            const ans = it.type === 'forced'
              ? `${names.a} picked "${it.a}"; ${names.b} picked "${it.b}"`
              : `${names.a}: ${it.a}; ${names.b}: ${it.b}`;
            return `${i + 1}. "${it.stem}" (probes ${why})\n   ${ans}`;
          })
          .join('\n')
      : '(none)';

  const decided = cmp.agreeCount + cmp.disagreeCount;

  return `Two people took the same 21-question values quiz (five dimensions scored 0.0–1.0: autonomy, care, openness, mastery, universalism). Write a short compatibility reading about the two of them, in the third person, naming them as ${names.a} and ${names.b}.

Their dimension scores:
${dimBlock}

Overall: they gave the same answer on ${cmp.agreeCount} of the ${decided} items where both took a side; closest on ${DIM_LABEL[cmp.closest]}, furthest apart on ${DIM_LABEL[cmp.furthest]}.

Agreements that are surprising given their profiles (they agree here even though their scores on the dimensions this item probes are far apart, or the agreement is unusually strong):
${itemBlock(cmp.agreements)}

Disagreements that are surprising given their profiles (they split here even though their scores on these dimensions are close):
${itemBlock(cmp.disagreements)}

Output:
- "headline": one sentence, at most 25 words, that says what kind of pair they are. Specific to these two, not a horoscope.
- "agreements": exactly ${cmp.agreements.length} strings, one per agreement above in the same order. Each 1–2 sentences: what they both said (quote or near-quote the item) and why it is surprising for these two. No numbering.
- "disagreements": exactly ${cmp.disagreements.length} strings, one per disagreement above in the same order, same shape: who said what, and why the split is interesting given how alike they are elsewhere.

Hard rules: lowercase prose; no bullets or headers; no "you"; no hedging ("might", "may tend to"); never invent an answer that is not listed above; keep the two names exactly as written.

Return JSON only, no prose before or after:
{"headline": "...", "agreements": ["..."], "disagreements": ["..."]}`;
}

export function parseCompareResponse(
  raw: unknown,
  expected: { agreements: number; disagreements: number },
): CompareNarrative | null {
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
  const headline = typeof obj.headline === 'string' ? obj.headline.trim() : '';
  if (!headline) return null;
  const strings = (v: unknown, n: number): string[] | null => {
    if (!Array.isArray(v)) return null;
    const out = v.filter((s): s is string => typeof s === 'string').map((s) => s.trim()).filter(Boolean);
    return out.length >= n ? out.slice(0, n) : null;
  };
  const agreements = strings(obj.agreements, expected.agreements);
  const disagreements = strings(obj.disagreements, expected.disagreements);
  if (!agreements || !disagreements) return null;
  return { headline, agreements, disagreements };
}

export interface GenerateCompareResult {
  narrative: CompareNarrative | null;
  error?: string;
}

const COMPARE_MODEL = 'anthropic/claude-haiku-4.5';
const COMPARE_TIMEOUT_MS = 20_000;

/**
 * One OpenRouter call (Claude Haiku 4.5, the same path and model as the
 * per-dim narratives). Null on any failure — the caller falls back to
 * `staticNarrative` so the page always renders.
 */
export async function generateCompareNarrative(
  env: Env,
  cmp: Comparison,
  names: CompareNames,
): Promise<GenerateCompareResult> {
  const apiKey = (env as { OPENROUTER_API_KEY?: string }).OPENROUTER_API_KEY;
  if (!apiKey) return { narrative: null, error: 'OPENROUTER_API_KEY not bound' };

  const expected = { agreements: cmp.agreements.length, disagreements: cmp.disagreements.length };
  const prompt = buildComparePrompt(cmp, names);
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://qbase.tech',
        'X-Title': 'qbase values compare',
      },
      body: JSON.stringify({
        model: COMPARE_MODEL,
        messages: [
          {
            role: 'system',
            content: 'You write short, specific compatibility readings for two people. You only output valid JSON matching the schema the user requests — no prose before or after.',
          },
          { role: 'user', content: prompt },
        ],
        max_tokens: 900,
        temperature: 0.7,
      }),
      signal: AbortSignal.timeout(COMPARE_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const msg = `openrouter ${res.status}: ${body.slice(0, 200)}`;
      console.error(`[values compare] ${msg}`);
      return { narrative: null, error: msg };
    }
    const response = (await res.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const content = response.choices?.[0]?.message?.content;
    const text = typeof content === 'string' ? content : null;
    if (text === null) return { narrative: null, error: 'no text in response' };
    const narrative = parseCompareResponse(text, expected);
    if (!narrative) {
      console.error(`[values compare] parse failed (len=${text.length}): ${text.slice(0, 400)}`);
      return { narrative: null, error: 'failed to parse JSON from response' };
    }
    return { narrative };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[values compare] openrouter call failed:', msg);
    return { narrative: null, error: msg };
  }
}
