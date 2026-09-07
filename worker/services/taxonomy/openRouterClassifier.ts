/**
 * Five-axis classifier over OpenRouter — the same path the values quiz
 * narratives use (worker/services/values/dimNarrativeGenerator.ts).
 *
 * Default model: Gemini 3.1 Flash Lite, reasoning effort low. Chosen
 * 2026-09-07 over Claude Haiku 4.5 (the first implementation) and GLM-5.3
 * Flash on the canonical test set + the 129 live questions: all three score
 * 39/39 on the gate, but GLM flips primary_type on 8/129 rows between two
 * identical runs at temperature 0, while Haiku and Gemini reproduce 129/129.
 * Gemini is also the fastest (~2.0 s vs 2.4 s) and ~3× cheaper than Haiku.
 * Override with the CLASSIFIER_MODEL / CLASSIFIER_REASONING wrangler vars
 * (see AIService.classifierOptionsFromEnv); re-check with
 * scripts/taxonomy-gate.ts --models=… before changing.
 *
 * Throws on transport / HTTP / parse failure so the caller (AIService) can
 * decide whether to fall back to the legacy Workers AI classifier.
 */

import {
  CLASSIFIER_SYSTEM_PROMPT,
  buildClassifierPrompt,
  extractJsonObject,
  normalizeClassification,
} from './prompt';
import type { QuestionTaxonomy } from './types';


const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

export interface OpenRouterUsage {
  model: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  reasoning_tokens?: number;
  cost?: number;
  latencyMs: number;
}

export interface OpenRouterClassifierOptions {
  model?: string;
  fetchImpl?: typeof fetch;
  now?: Date;
  /** Cap on completion tokens (reasoning tokens count against it on reasoning models). */
  maxTokens?: number;
  /**
   * OpenRouter `reasoning` param for models that think before answering:
   * `{ effort: 'low' }` keeps them cheap, `{ enabled: false }` turns it off
   * where the model allows. Omitted → the model's default.
   */
  reasoning?: { effort?: 'low' | 'medium' | 'high' | 'max'; enabled?: boolean; exclude?: boolean };
  /** Called with token usage after a successful reply (the gate script's cost accounting). */
  onUsage?: (usage: OpenRouterUsage) => void;
}

export const DEFAULT_CLASSIFIER_MODEL = 'google/gemini-3.1-flash-lite';
/** Applied only when no model override is given, so the prod path matches what the gate measured. */
export const DEFAULT_CLASSIFIER_OPTIONS: Pick<OpenRouterClassifierOptions, 'reasoning' | 'maxTokens'> = {
  reasoning: { effort: 'low' },
  maxTokens: 2500,
};
/** The first v2 classifier; kept as a named alternative for CLASSIFIER_MODEL. */
export const HAIKU_CLASSIFIER_MODEL = 'anthropic/claude-haiku-4.5';

function extractText(response: Record<string, unknown>): string | null {
  const choices = response.choices as
    | Array<{ message?: { content?: unknown; reasoning?: unknown }; text?: unknown }>
    | undefined;
  if (Array.isArray(choices) && choices[0]) {
    const c = choices[0];
    if (typeof c.message?.content === 'string' && c.message.content.trim().length > 0) return c.message.content;
    if (typeof c.text === 'string' && c.text.trim().length > 0) return c.text;
    // Reasoning model that spent its budget thinking: the JSON may be in the trace.
    if (typeof c.message?.reasoning === 'string') return c.message.reasoning;
  }
  return null;
}

export async function classifyWithOpenRouter(
  apiKey: string,
  stem: string,
  options?: string[],
  opts: OpenRouterClassifierOptions = {},
): Promise<QuestionTaxonomy> {
  const model = opts.model ?? DEFAULT_CLASSIFIER_MODEL;
  const reasoning = opts.reasoning ?? (opts.model ? undefined : DEFAULT_CLASSIFIER_OPTIONS.reasoning);
  const maxTokens = opts.maxTokens ?? (opts.model ? 600 : DEFAULT_CLASSIFIER_OPTIONS.maxTokens);
  const doFetch = opts.fetchImpl ?? fetch;
  const prompt = buildClassifierPrompt(stem, options, opts.now);
  const started = Date.now();

  const res = await doFetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://qbase.tech',
      'X-Title': 'qbase question classifier',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: CLASSIFIER_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      max_tokens: maxTokens,
      temperature: 0,
      ...(reasoning ? { reasoning } : {}),
      // Ask OpenRouter to include the accounted cost on the usage object.
      usage: { include: true },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`openrouter ${res.status}: ${body.slice(0, 200)}`);
  }

  const response = (await res.json()) as Record<string, unknown>;
  const text = extractText(response);
  if (text === null) {
    throw new Error(`no text in openrouter response: ${JSON.stringify(response).slice(0, 300)}`);
  }
  const parsed = extractJsonObject(text);
  if (!parsed) {
    throw new Error(`classifier reply is not JSON: ${text.slice(0, 300)}`);
  }
  if (opts.onUsage) {
    const u = (response.usage ?? {}) as Record<string, unknown>;
    const details = (u.completion_tokens_details ?? {}) as Record<string, unknown>;
    opts.onUsage({
      model: typeof response.model === 'string' ? response.model : model,
      prompt_tokens: typeof u.prompt_tokens === 'number' ? u.prompt_tokens : undefined,
      completion_tokens: typeof u.completion_tokens === 'number' ? u.completion_tokens : undefined,
      reasoning_tokens: typeof details.reasoning_tokens === 'number' ? details.reasoning_tokens : undefined,
      cost: typeof u.cost === 'number' ? u.cost : undefined,
      latencyMs: Date.now() - started,
    });
  }
  return normalizeClassification(parsed, stem, model);
}
