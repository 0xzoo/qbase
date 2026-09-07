/**
 * classifyForRegistration — v2 taxonomy for a canonical quiz item at insert
 * (card t_26b2e821, follow-up to Typology B2).
 *
 * The admin-register-*-queries routes used to insert quiz questions with
 * taxonomy NULL and leave the sweep to scripts/reclassify-questions.ts. Every
 * item is now classified on the way in, on the OpenRouter path only: the
 * legacy 3B tree was never meant for Likert statements, so an outage yields
 * NULL plus a log line rather than a wrong label, and the sweep script can
 * still fill it later. Registration never blocks on the classifier.
 */

import { AIService } from '../AIService';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

export type RegistrationTaxonomyStatus = 'classified' | 'invalid' | 'unavailable';

export interface RegistrationTaxonomy {
  /** JSON for `queries.taxonomy`; null when nothing trustworthy came back */
  json: string | null;
  status: RegistrationTaxonomyStatus;
}

export async function classifyForRegistration(env: Env, stem: string, options?: string[]): Promise<RegistrationTaxonomy> {
  try {
    const taxonomy = await AIService.fromEnv(env).classifyQuestion(stem, options, 'openrouter');
    if (taxonomy.primary_type === 'invalid') {
      console.warn(`[registerClassify] classifier called "${stem.slice(0, 60)}" invalid; storing taxonomy NULL`);
      return { json: null, status: 'invalid' };
    }
    return { json: JSON.stringify(taxonomy), status: 'classified' };
  } catch (e) {
    console.warn(`[registerClassify] classifier unavailable for "${stem.slice(0, 60)}"; storing taxonomy NULL:`, e);
    return { json: null, status: 'unavailable' };
  }
}
