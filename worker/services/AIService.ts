/**
 * AIService — question classification entry point.
 *
 * Dispatches to the five-axis Haiku 4.5 classifier (OpenRouter) when
 * `OPENROUTER_API_KEY` is bound, and to the legacy Workers AI 3B decision
 * tree otherwise or when OpenRouter fails. Both return a `QuestionTaxonomy`;
 * only the Haiku path carries the axes and derived labels
 * (`taxonomy_version: 2`). Spec: docs/specs/question-typology.md.
 */

import { classifyWithOpenRouter } from './taxonomy/haikuClassifier';
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

/** `auto` = Haiku when the key is bound, legacy as the fallback. */
export type ClassifierChoice = 'auto' | 'haiku' | 'legacy';

export class AIService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private ai: any;
  private openRouterKey?: string;

  static fromEnv(env: Env): AIService {
    return new AIService(env?.AI, env?.OPENROUTER_API_KEY);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(ai: any, openRouterKey?: string) {
    this.ai = ai;
    this.openRouterKey = openRouterKey;
  }

  /**
   * Classify a question. Never throws in `auto` mode: an OpenRouter failure
   * falls back to the legacy classifier, and a missing AI binding falls back
   * to the safe default (knowledge/discussion) so creation is never blocked.
   * `haiku` / `legacy` force a path (used by the dev test route and the gate
   * script) and surface errors.
   */
  async classifyQuestion(
    stem: string,
    options?: string[],
    choice: ClassifierChoice = 'auto',
  ): Promise<QuestionTaxonomy> {
    const wantHaiku = choice === 'haiku' || (choice === 'auto' && !!this.openRouterKey);
    if (wantHaiku) {
      if (!this.openRouterKey) throw new Error('OPENROUTER_API_KEY not bound');
      try {
        return await classifyWithOpenRouter(this.openRouterKey, stem, options);
      } catch (error) {
        console.error('[AIService] haiku classifier failed', error);
        if (choice === 'haiku') throw error;
      }
    }
    if (!this.ai) {
      if (choice === 'legacy') throw new Error('AI binding not available');
      return legacyFallbackTaxonomy('Classification unavailable — no classifier reachable');
    }
    return classifyWithWorkersAi(this.ai, stem, options);
  }
}
