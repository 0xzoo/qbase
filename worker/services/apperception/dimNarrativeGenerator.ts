// apperception — per-dimension narrative generator.
//
// Wraps the static styleNarratives in scoring.ts as the fallback. LLM-generated
// personalized narratives (per user scores + strongest contributions) are
// deferred — same pattern as values v1 which shipped with static narratives
// before wiring OpenRouter.

import {
  type ApperceptionAxis,
} from './questions';
import type { ApperceptionAnswer, ApperceptionScore } from './scoring';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

export type DimNarrative = { summary: string; blindSpot: string };
export type DimNarratives = Record<ApperceptionAxis, DimNarrative>;

export const DIM_NARRATIVES_VERSION = 1;

const DIMS: readonly ApperceptionAxis[] = ['concrete', 'reflective', 'sequential'];

const poleLabels: Record<ApperceptionAxis, { high: string; low: string }> = {
  concrete: { high: 'example-first', low: 'principle-first' },
  reflective: { high: 'think-before-acting', low: 'learn-by-doing' },
  sequential: { high: 'step-by-step', low: 'big-picture-first' },
};

export function generateDimNarratives(
  _env: Env,
  scores: ApperceptionScore,
  _answers: ApperceptionAnswer[],
): DimNarratives {
  // Static narratives — LLM personalization deferred
  const result: DimNarratives = {} as DimNarratives;

  for (const dim of DIMS) {
    const score = scores[dim];
    const pole = score > 0.5 ? 'high' : 'low';
    const intensity = Math.round(Math.abs(score - 0.5) * 2 * 100);
    const label = poleLabels[dim][pole];

    result[dim] = {
      summary: `you lean ${label} (${intensity}%). ${dimNarratives[dim][pole].summary}`,
      blindSpot: dimNarratives[dim][pole].blindSpot,
    };
  }

  return result;
}

const dimNarratives: Record<ApperceptionAxis, Record<string, DimNarrative>> = {
  concrete: {
    high: {
      summary: "examples and demonstrations are your starting point. you understand best when someone shows you how something works — the abstract principle comes after.",
      blindSpot: "you can miss the underlying pattern. sometimes the principle explains five examples at once.",
    },
    low: {
      summary: "you want the framework first. once you have the rule or theory, the examples make sense — but you need the principle to orient.",
      blindSpot: "you can live in abstraction. sometimes the thing you're analyzing doesn't behave like the model predicts.",
    },
  },
  reflective: {
    high: {
      summary: "you think before you act. planning, modeling, understanding — these aren't procrastination, they're how you get oriented before committing.",
      blindSpot: "planning can become its own activity. sometimes you need to build something (even if it's wrong) to learn what you're actually trying to make.",
    },
    low: {
      summary: "you learn by doing. building, experimenting, iterating — you understand through action, not through planning.",
      blindSpot: "speed can outpace understanding. the fastest path sometimes skips the thing you actually needed to learn.",
    },
  },
  sequential: {
    high: {
      summary: "you process best in order. step-by-step, building-block explanations fit how you think — prerequisites come first, each step depends on the last.",
      blindSpot: "you can get stuck in the sequence. sometimes the insight is at the end, and you need to jump there first to understand the beginning.",
    },
    low: {
      summary: "you want the big picture first. the whole system overview matters more than the sequence — you'll zoom into details as you need them.",
      blindSpot: "you can skip the foundations. the architecture view sometimes hides the detail that changes everything.",
    },
  },
};
