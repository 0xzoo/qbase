/**
 * Five-axis classifier on Claude Haiku 4.5 via OpenRouter — the same path
 * the values quiz narratives use (worker/services/values/dimNarrativeGenerator.ts).
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

export const HAIKU_CLASSIFIER_MODEL = 'anthropic/claude-haiku-4.5';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

export interface OpenRouterClassifierOptions {
  model?: string;
  fetchImpl?: typeof fetch;
  now?: Date;
}

function extractText(response: Record<string, unknown>): string | null {
  const choices = response.choices as
    | Array<{ message?: { content?: unknown }; text?: unknown }>
    | undefined;
  if (Array.isArray(choices) && choices[0]) {
    const c = choices[0];
    if (typeof c.message?.content === 'string') return c.message.content;
    if (typeof c.text === 'string') return c.text;
  }
  return null;
}

export async function classifyWithOpenRouter(
  apiKey: string,
  stem: string,
  options?: string[],
  opts: OpenRouterClassifierOptions = {},
): Promise<QuestionTaxonomy> {
  const model = opts.model ?? HAIKU_CLASSIFIER_MODEL;
  const doFetch = opts.fetchImpl ?? fetch;
  const prompt = buildClassifierPrompt(stem, options, opts.now);

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
      max_tokens: 600,
      temperature: 0,
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
  return normalizeClassification(parsed, stem, model);
}
