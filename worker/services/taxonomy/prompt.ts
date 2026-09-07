/**
 * Five-axis classifier prompt + response normalization.
 *
 * The prompt asks for five independent judgments (spec § Prompt shape) and
 * the facets; `normalizeClassification` validates every enum, derives the
 * routing labels in code, and applies the two heuristics the v1 classifier
 * relied on (trailing-colon templates, temporal-marker fill-in).
 */

import { deriveLabels, parseAxes } from './derive';
import {
  CONSTRUCTION_TYPES, CONTENT_TAGS, FRAMES, SENSITIVITIES,
  isOneOf,
  type ContentTag,
  type Frame,
  type QuestionTaxonomy,
} from './types';

export const TAXONOMY_VERSION = 2 as const;

const TEMPORAL_MARKERS = [
  'today', 'tonight', 'right now', 'rn', 'currently', 'this week', 'this month',
  'this year', 'recently', 'at this moment', 'current', 'lately', 'this moment',
  'this weekend', 'tomorrow',
];

export function buildClassifierPrompt(stem: string, options?: string[], now: Date = new Date()): string {
  const month = now.toLocaleString('en-US', { month: 'long' });
  const year = now.getFullYear();
  const optionsInfo = options && options.length > 0
    ? `Options: ${options.map((o) => JSON.stringify(o)).join(', ')}`
    : 'No options provided';

  return `Current date: ${month} ${year}

Classify the question below along five independent axes. Judge each axis on its own evidence; do not reason from a category name. Then fill in the facets.

AXES

referent — whose state does the answer describe?
  self   the answerer: their mood, habits, opinions, plans, history
  world  something outside the answerer: a person, event, market, fact, product

mode — what kind of thing is the answer?
  stance  no truth value: a preference, value, judgment, taste, rating, moral verdict, a best/worst pick
  report  a fact only the answerer can verify: mood, location, habits, demographics, personal history, intentions
  claim   a fact others could verify in principle, now or later: a definition, an explanation, a forecast, a fix

tense — when is the referent state?
  past | present | future | timeless   (timeless = not anchored in time: traits, definitions, general preferences)
  For a claim, tense is when it becomes checkable: if it can only be settled by what happens next, it is future.

volatility — how fast is the true answer expected to change?
  stable    months or longer: traits, values, general preferences, settled history
  volatile  hours to days: "right now", "today", mood, current activity, a momentary pick
  event     settles once and stays settled: a forecast, a checkable fact, a one-off outcome

intent — what product does the asker want?
  measure  the distribution of answers across people: a survey, poll, referendum, "what do you think", a vote among the asker's options
  request  the single best answer for the asker: help, advice, how-to, a recommendation, troubleshooting, an explanation

Worked examples (stem → referent, mode, tense, volatility, intent):
- "gonna be a big week?" → world, claim, future, event, measure
- "how are you feeling rn?" → self, report, present, volatile, measure
- "will you vote this year?" → self, report, future, event, measure
- "do you like pineapple pizza?" → self, stance, timeless, stable, measure
- "is X guilty?" → world, stance, past, stable, measure
- "what's the best editor?" → world, stance, timeless, stable, measure (frame: comparative)
- "what's the capital of Peru?" → world, claim, timeless, event, measure
- "how do I fix this cargo error?" → world, claim, present, event, request
- "farcaster season 3 is over. what do you want in season 4?" → world, stance, future, stable, measure
- "which name should I give my dog: Miso or Bean?" → world, stance, timeless, stable, measure (the asker wants a vote)

Notes:
- Superlatives, ratings, and moral verdicts are stances even when phrased as facts ("is X the best", "is X guilty", "is X worth it").
- A question about the answerer's own past ("what were you like as a teenager", "how did you learn to code") is self, report, past, stable.
- "Would you rather" / "this or that" stems with options are self, stance, timeless, stable.
- Asking the crowd to predict something is claim, future, measure. Asking how to do or fix something, or for an explanation, is request.
- A claim phrased in the present that can only be checked later ("is the bottom in?", "is this the top?", "is AGI already here?") is tense future, volatility event: nobody can verify it today, so it is a forecast, not a fact.
- A momentary preference ("right now, coffee or tea?") is self, stance, present, volatile.
- A Likert statement about the answerer ("i look out for my own first") is self, stance or report, timeless, stable, measure.

FACETS

frame — zero or more of: hypothetical (counterfactual, "if you could"), comparative (best/worst/rank/versus), normative (should/ought)
construction_type — complete (self-contained) | template (an incomplete stem that needs the options to make sense, often ending in a colon) | follow_up (depends on a previous answer)
content_tags — for stance and report questions, one or more of: belief, preference, behavioral, emotional, demographic, social, evaluative, personal_history. Empty for claims.
topics — 1 to 3 lowercase topics: concrete entities or specific concepts ("rust", "nyc", "donald trump", "sleep"); never vague words like "life", "people", "question".
temporal_markers — words in the stem that anchor it in time ("today", "rn", "this week", "in 2026"); empty if none.
sensitivity — low | medium | high: the privacy cost of answering honestly.
safety_flag — true only for NSFW, hateful, or dangerous content.
is_question — false only if the input is not something people could answer at all (spam, gibberish, an empty or self-contained remark). A statement offered for agreement (a Likert item like "i prefer routines that work over experiments"), an open prompt ("confess here", "tell us about your crush"), or an incomplete stem with options is answerable: classify it, is_question true.

Question: ${JSON.stringify(stem)}
${optionsInfo}

Respond with only this JSON object and nothing else:
{
  "is_question": true,
  "referent": "self" | "world",
  "mode": "stance" | "report" | "claim",
  "tense": "past" | "present" | "future" | "timeless",
  "volatility": "stable" | "volatile" | "event",
  "intent": "measure" | "request",
  "frame": [],
  "construction_type": "complete" | "template" | "follow_up",
  "content_tags": [],
  "topics": [],
  "temporal_markers": [],
  "sensitivity": "low" | "medium" | "high",
  "safety_flag": false,
  "rationale": { "referent": "...", "mode": "...", "tense": "...", "volatility": "...", "intent": "..." }
}
Each rationale value is one short clause, under 15 words.`;
}

export const CLASSIFIER_SYSTEM_PROMPT =
  'You classify questions for qbase, a platform where people ask a crowd. You output exactly one JSON object and no prose.';

/** Pull the first JSON object out of a model reply. Returns null if none parses. */
export function extractJsonObject(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return null;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function stringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim());
}

function findTemporalMarkers(stem: string): string[] {
  const lower = stem.toLowerCase();
  return TEMPORAL_MARKERS.filter((m) =>
    // word-ish boundary so "rn" doesn't match inside "corner"
    new RegExp(`(^|[^a-z])${m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`).test(lower),
  );
}

function joinRationale(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (v && typeof v === 'object') {
    return Object.entries(v as Record<string, unknown>)
      .filter(([, val]) => typeof val === 'string' && (val as string).trim().length > 0)
      .map(([k, val]) => `${k}: ${(val as string).trim()}`)
      .join('; ');
  }
  return '';
}

export function invalidTaxonomy(reasoning: string, classifier: string): QuestionTaxonomy {
  return {
    primary_type: 'invalid',
    construction_type: 'complete',
    content_tags: [],
    is_template: false,
    reasoning,
    topics: [],
    taxonomy_version: TAXONOMY_VERSION,
    classifier,
    classified_at: new Date().toISOString(),
  };
}

/**
 * Turn a parsed model reply into a stored taxonomy: validate every enum,
 * derive the labels, apply the heuristics. Never throws.
 */
export function normalizeClassification(
  parsed: Record<string, unknown>,
  stem: string,
  classifier: string,
): QuestionTaxonomy {
  const reasoning = joinRationale(parsed.rationale) || (typeof parsed.reasoning === 'string' ? parsed.reasoning : '');

  if (parsed.is_question === false) {
    return invalidTaxonomy(reasoning || 'Input is not a question', classifier);
  }
  const axes = parseAxes(parsed);
  if (!axes) {
    return invalidTaxonomy(reasoning || 'Classifier returned unparseable axes', classifier);
  }
  const derived = deriveLabels(axes);

  const construction_type = isOneOf(CONSTRUCTION_TYPES, parsed.construction_type)
    ? parsed.construction_type
    : 'complete';
  const trimmedStem = stem.trim();
  const isTemplate = construction_type === 'template' || trimmedStem.endsWith(':');

  const content_tags = axes.mode === 'claim'
    ? []
    : stringList(parsed.content_tags).map((t) => t.toLowerCase()).filter((t): t is ContentTag => isOneOf(CONTENT_TAGS, t));
  const frame = stringList(parsed.frame).map((f) => f.toLowerCase()).filter((f): f is Frame => isOneOf(FRAMES, f));
  const topics = stringList(parsed.topics).map((t) => t.toLowerCase()).slice(0, 3);
  const modelMarkers = stringList(parsed.temporal_markers);
  const temporal_markers = modelMarkers.length > 0 ? modelMarkers : findTemporalMarkers(stem);
  const sensitivity = isOneOf(SENSITIVITIES, parsed.sensitivity) ? parsed.sensitivity : undefined;

  return {
    primary_type: derived.primary_type,
    construction_type: isTemplate ? 'template' : construction_type,
    content_tags,
    temporal_markers,
    safety_flag: parsed.safety_flag === true,
    ...(sensitivity ? { sensitivity } : {}),
    is_template: isTemplate,
    reasoning,
    topics,
    ...axes,
    frame,
    resolvability: derived.resolvability,
    signal: derived.signal,
    wave_relevance: derived.wave_relevance,
    clout_eligible: derived.clout_eligible,
    taxonomy_version: TAXONOMY_VERSION,
    classifier,
    classified_at: new Date().toISOString(),
  };
}
