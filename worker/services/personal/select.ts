/**
 * Decision → the owner's questions that bear on it, plus what's missing
 * (docs/specs/personal-mcp.md §3.6.1).
 *
 * One cheap call on the classifier path (Gemini Flash Lite via OpenRouter).
 * What the provider sees: the agent's decision text, and the stems + options
 * of the owner's questions. Never an answer, and never a sealed stem: that is
 * `candidatesOf`'s invariant (context.ts), not a property of today's data.
 * The decision text is the agent's own words and can be as sensitive as an
 * answer; the key-creation copy (consent_copy 'mcp-key-v2') names this
 * provider as a reader, and get_context's description asks agents to keep the
 * decision general.
 *
 * Why a judge and not cosine: the 2026-10-07 prototype against Zoo's record
 * (scripts/personal-context-prototype.ts) put every short "what's your X?"
 * stem at bge cosine 0.55–0.75 from every probe, relevant or not ("drug of
 * choice" ↔ "government intervention" 0.63). Similarity measures "both are
 * personal questions"; whether a position bears on a decision takes a reader.
 * Embeddings stay as recall when a record is too big for one prompt
 * (`recallByProbes` in context.ts).
 */

import { DEFAULT_CLASSIFIER_MODEL } from '../taxonomy/openRouterClassifier';
import { extractJsonObject } from '../taxonomy/prompt';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
/** Candidates per judge call. Above this the caller recalls by embedding first. */
export const MAX_CANDIDATES = 160;
export const MAX_GAPS = 6;

export interface Candidate {
  /** Opaque to the model; echoed back. */
  id: string;
  /** Stem, with options for choice questions (context.ts `embedText`). */
  text: string;
}

export interface Selected {
  id: string;
  /** One line: how this position bears on the decision. */
  why: string;
}

export interface Selection {
  /** Most relevant first. */
  selected: Selected[];
  /** Short general questions the owner hasn't answered whose answers would change the advice. */
  gaps: string[];
  via: 'model' | 'fallback';
  error?: string;
}

const SYSTEM = `You help an assistant advise one person on a decision, using what the person has said before.
You get the decision and a numbered list of questions the person has answered (only the questions, not the answers).
1. Pick the questions whose answers would actually change or inform the advice. Be strict: a question that is only
   loosely personal, or about the same broad area without bearing on this choice, does not count. Picking none is fine.
2. List up to ${MAX_GAPS} short general questions (at most 10 words, no examples, nothing about the decision's
   specifics) that the person has NOT answered and that would most change the advice.
Reply with JSON only:
{"relevant": [{"n": <number>, "why": "<at most 12 words>"}], "gaps": ["...", ...]}
Order "relevant" most important first.`;

export interface SelectOptions {
  apiKey?: string;
  model?: string;
  fetchImpl?: typeof fetch;
}

export async function selectRelevant(
  decision: string,
  context: string | undefined,
  candidates: Candidate[],
  opts: SelectOptions,
): Promise<Selection> {
  const fallback = (error: string): Selection => ({ selected: [], gaps: [], via: 'fallback', error });
  if (!opts.apiKey) return fallback('no OPENROUTER_API_KEY');
  const list = candidates.slice(0, MAX_CANDIDATES);
  const numbered = list.map((c, i) => `${i + 1}. ${c.text.replace(/\s+/g, ' ')}`).join('\n');
  const user = `Decision: ${decision}${context ? `\nContext: ${context}` : ''}\n\nQuestions the person has answered:\n${numbered || '(none)'}`;
  try {
    const res = await (opts.fetchImpl ?? fetch)(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://qbase.tech',
        'X-Title': 'qbase personal context',
      },
      body: JSON.stringify({
        model: opts.model ?? DEFAULT_CLASSIFIER_MODEL,
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }],
        max_tokens: 1500,
        temperature: 0,
        reasoning: { effort: 'low' },
      }),
    });
    if (!res.ok) return fallback(`openrouter ${res.status}`);
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return parseSelection(json.choices?.[0]?.message?.content ?? '', list);
  } catch (e) {
    return fallback(e instanceof Error ? e.message : String(e));
  }
}

/** Exported for tests: the model's numbers → candidate ids, dropping anything out of range or repeated. */
export function parseSelection(text: string, list: Candidate[]): Selection {
  const parsed = extractJsonObject(text);
  if (!parsed) return { selected: [], gaps: [], via: 'fallback', error: 'reply is not JSON' };
  const seen = new Set<string>();
  const selected: Selected[] = [];
  for (const r of Array.isArray(parsed.relevant) ? parsed.relevant : []) {
    const n = Number((r as { n?: unknown })?.n);
    const c = Number.isInteger(n) ? list[n - 1] : undefined;
    if (!c || seen.has(c.id)) continue;
    seen.add(c.id);
    const why = (r as { why?: unknown }).why;
    selected.push({ id: c.id, why: typeof why === 'string' ? why.trim() : '' });
  }
  const gaps = (Array.isArray(parsed.gaps) ? parsed.gaps : [])
    .filter((g): g is string => typeof g === 'string' && g.trim().length > 0)
    .map((g) => g.trim())
    .slice(0, MAX_GAPS);
  return { selected, gaps, via: 'model' };
}
