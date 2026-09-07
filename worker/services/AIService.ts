/**
 * AIService — question classification entry point.
 *
 * Dispatches to the five-axis OpenRouter classifier (default Gemini 3.1
 * Flash Lite, see taxonomy/openRouterClassifier.ts) when `OPENROUTER_API_KEY`
 * is bound, and to the legacy Workers AI 3B decision tree otherwise or when
 * OpenRouter fails. Both return a `QuestionTaxonomy`; only the OpenRouter
 * path carries the axes and derived labels (`taxonomy_version: 2`).
 * Spec: docs/specs/question-typology.md.
 */

import { classifyWithOpenRouter, type OpenRouterClassifierOptions } from './taxonomy/openRouterClassifier';
import { classifyWithWorkersAi, legacyFallbackTaxonomy } from './taxonomy/legacyClassifier';
import type { QuestionTaxonomy } from './taxonomy/types';

export type { QuestionTaxonomy } from './taxonomy/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

export interface ParsedQuery {
  type: 'text' | 'multiple_choice' | 'scale';
  options?: string[];
  scaleLabels?: { start: string; end: string };
}

/** `auto` = OpenRouter when the key is bound, legacy as the fallback. */
export type ClassifierChoice = 'auto' | 'openrouter' | 'legacy';

/**
 * `CLASSIFIER_MODEL` (wrangler var) overrides the OpenRouter model id — when
 * set, the default reasoning/max-token settings are *not* applied, so pair it
 * with `CLASSIFIER_REASONING` = 'low' | 'medium' | 'high' | 'off' for models
 * that think before answering (e.g. Haiku 4.5 needs neither). Both optional.
 */
export function classifierOptionsFromEnv(env: Env): OpenRouterClassifierOptions {
  const opts: OpenRouterClassifierOptions = {};
  const model = env?.CLASSIFIER_MODEL;
  if (typeof model === 'string' && model.trim()) opts.model = model.trim();
  const reasoning = env?.CLASSIFIER_REASONING;
  if (reasoning === 'off') opts.reasoning = { enabled: false };
  else if (reasoning === 'low' || reasoning === 'medium' || reasoning === 'high') opts.reasoning = { effort: reasoning };
  return opts;
}

export class AIService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private ai: any;
  private openRouterKey?: string;
  private openRouterOpts: OpenRouterClassifierOptions;

  static fromEnv(env: Env): AIService {
    return new AIService(env?.AI, env?.OPENROUTER_API_KEY, classifierOptionsFromEnv(env));
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(ai: any, openRouterKey?: string, openRouterOpts: OpenRouterClassifierOptions = {}) {
    this.ai = ai;
    this.openRouterKey = openRouterKey;
    this.openRouterOpts = openRouterOpts;
  }

  /**
   * Classify a question. Never throws in `auto` mode: an OpenRouter failure
   * falls back to the legacy classifier, and a missing AI binding falls back
   * to the safe default (knowledge/discussion) so creation is never blocked.
   * `openrouter` / `legacy` force a path (used by the dev test route and the
   * gate script) and surface errors.
   */
  async classifyQuestion(
    stem: string,
    options?: string[],
    choice: ClassifierChoice = 'auto',
  ): Promise<QuestionTaxonomy> {
    const wantOpenRouter = choice === 'openrouter' || (choice === 'auto' && !!this.openRouterKey);
    if (wantOpenRouter) {
      if (!this.openRouterKey) throw new Error('OPENROUTER_API_KEY not bound');
      try {
        return await classifyWithOpenRouter(this.openRouterKey, stem, options, this.openRouterOpts);
      } catch (error) {
        console.error('[AIService] openrouter classifier failed', error);
        if (choice === 'openrouter') throw error;
      }
    }
    if (!this.ai) {
      if (choice === 'legacy') throw new Error('AI binding not available');
      return legacyFallbackTaxonomy('Classification unavailable — no classifier reachable');
    }
    return classifyWithWorkersAi(this.ai, stem, options);
  }
}
