// apperception — scoring across 3 bipolar dims, free + gated tier results.
//
// Each dim scored 0-1 (bipolar: 0 = strong low-end preference, 1 = strong
// high-end preference, 0.5 = no leaning). 8 primary styles from the sign
// pattern (high/low on each dim).
//
// Algorithm per dim:
//   raw[d] = sum(answer_weight × dim_weight[d]) / sum(max_aw × |dim_weight[d]|)
//   score[d] = clamp01((raw[d] + 1) / 2)
//
// No open-text blending — pure explicit self-report.

import {
  apperceptionQuestions,
  LIKERT_ANSWER_WEIGHTS,
  LIKERT_LABELS,
  type ApperceptionAxis,
} from './questions';

const DIMS: readonly ApperceptionAxis[] = ['concrete', 'reflective', 'sequential'];

export type ApperceptionAnswer =
  | { questionId: string; type: 'likert'; position: number }   // 0..4 (SD..SA)
  | { questionId: string; type: 'forced'; optionIndex: number }; // 0 | 1

export interface ApperceptionScore {
  concrete: number;    // 0-1, high = example-first
  reflective: number;  // 0-1, high = think-before-acting
  sequential: number;  // 0-1, high = step-by-step
  confidence: number;  // 0-1, fraction of scorable items answered
}

const NEUTRAL_SCORE: ApperceptionScore = {
  concrete: 0.5,
  reflective: 0.5,
  sequential: 0.5,
  confidence: 0,
};

const SCORABLE_COUNT = apperceptionQuestions.filter(
  (q) => q.type === 'likert' || q.type === 'forced',
).length;

const LIKERT_MAX_AW = 2;  // max |answer_weight| for Likert (the "Strongly" ends)
const FORCED_AW = 1;

export function scoreApperception(answers: ApperceptionAnswer[]): ApperceptionScore {
  const byId = new Map(apperceptionQuestions.map((q) => [q.id, q]));

  const num: Record<ApperceptionAxis, number> = {
    concrete: 0, reflective: 0, sequential: 0,
  };
  const den: Record<ApperceptionAxis, number> = {
    concrete: 0, reflective: 0, sequential: 0,
  };
  let scored = 0;

  for (const ans of answers) {
    const q = byId.get(ans.questionId);
    if (!q) continue;

    if (q.type === 'likert' && ans.type === 'likert') {
      const aw = LIKERT_ANSWER_WEIGHTS[ans.position];
      if (aw === undefined) continue;
      scored++;
      for (const d of DIMS) {
        const w = q.weights[d];
        if (typeof w !== 'number') continue;
        num[d] += aw * w;
        den[d] += LIKERT_MAX_AW * Math.abs(w);
      }
    } else if (q.type === 'forced' && ans.type === 'forced') {
      const opt = q.a_options[ans.optionIndex];
      if (!opt) continue;
      scored++;
      for (const d of DIMS) {
        const w = opt.weights[d];
        if (typeof w !== 'number') continue;
        num[d] += FORCED_AW * w;
        const maxAbs = Math.max(
          Math.abs(q.a_options[0].weights[d] ?? 0),
          Math.abs(q.a_options[1].weights[d] ?? 0),
        );
        den[d] += FORCED_AW * maxAbs;
      }
    }
  }

  const score: ApperceptionScore = { ...NEUTRAL_SCORE };
  for (const d of DIMS) {
    if (den[d] === 0) {
      score[d] = 0.5;
    } else {
      const raw = num[d] / den[d]; // -1..+1
      score[d] = clamp01((raw + 1) / 2);
    }
  }
  score.confidence = SCORABLE_COUNT > 0 ? Math.min(1, scored / SCORABLE_COUNT) : 0;
  return score;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

// ---------- Style assignment ----------

export type ApperceptionStyle = string; // "The Architect" etc.
export type StyleConfidence = 'strong' | 'moderate' | 'mild';

export interface ApperceptionStyleResult {
  style: string;          // e.g. "The Architect"
  blended: boolean;       // true if any dim is in [0.4, 0.6] → "Leaning ..."
  confidence: StyleConfidence;
}

export function assignStyle(scores: ApperceptionScore): ApperceptionStyleResult {
  const c = scores.concrete;
  const r = scores.reflective;
  const s = scores.sequential;

  // Primary style from sign pattern
  const highC = c > 0.5 ? 'E' : 'P';  // Example / Principle
  const highR = r > 0.5 ? 'R' : 'A';  // Reflective / Active
  const highS = s > 0.5 ? 'S' : 'I';  // Sequential / Integrative

  const key = highC + highR + highS;  // e.g. "ERS" = Example+Reflective+Sequential
  const style = styleNames[key] ?? 'Unclassified';

  // Blended: any dim in [0.4, 0.6] → "Leaning" prefix
  const blended = anyInBand(scores, 0.4, 0.6);

  // Confidence band
  let conf: StyleConfidence;
  const decisive = [c, r, s].filter((v) => v > 0.65 || v < 0.35).length;
  if (decisive === 3) conf = 'strong';
  else if (decisive >= 2) conf = 'moderate';
  else conf = 'mild';

  return {
    style,
    blended,
    confidence: conf,
  };
}

function anyInBand(scores: ApperceptionScore, lo: number, hi: number): boolean {
  return (
    (scores.concrete >= lo && scores.concrete <= hi) ||
    (scores.reflective >= lo && scores.reflective <= hi) ||
    (scores.sequential >= lo && scores.sequential <= hi)
  );
}

const styleNames: Record<string, string> = {
  ERS: 'Architect',    // Example, Reflective, Step-by-step
  EAS: 'Practitioner', // Example, Active, Step-by-step
  ERI: 'Cartographer', // Example, Reflective, Integrative
  EAI: 'Hacker',       // Example, Active, Integrative
  PRS: 'Theorist',     // Principle, Reflective, Step-by-step
  PAS: 'Sprinter',     // Principle, Active, Step-by-step
  PRI: 'Navigator',    // Principle, Reflective, Integrative
  PAI: 'Builder',      // Principle, Active, Integrative
};

// ---------- Free tier ----------

export interface ApperceptionFreeTierResult {
  scores: ApperceptionScore;
  style: ApperceptionStyleResult;
  summary: string;                          // 1 paragraph keyed to primary style
  signatureAnswers: string[];               // 3 strongest contributions across all dims
}

export function freeTierResult(answers: ApperceptionAnswer[]): ApperceptionFreeTierResult {
  const scores = scoreApperception(answers);
  const style = assignStyle(scores);

  return {
    scores,
    style,
    summary: styleNarratives[style.style]?.summary ??
      'You have a unique cognitive style that blends multiple approaches.',
    signatureAnswers: pickSignatureAnswers(answers),
  };
}

// ---------- Gated tier ----------

export interface ApperceptionGatedTierResult extends ApperceptionFreeTierResult {
  ranked: ApperceptionAxis[];       // 3 dims, dominant → least
  allStyles: Array<{ name: string; match: number }>; // 8 styles with match percentages
  styleBreakdown: string;           // text summary of all 3 dim scores
}

export function gatedTierResult(answers: ApperceptionAnswer[]): ApperceptionGatedTierResult {
  const scores = scoreApperception(answers);
  const style = assignStyle(scores);
  const ranked = rankDims(scores);

  return {
    scores,
    style,
    ranked,
    summary: styleNarratives[style.style]?.summary ??
      'You have a unique cognitive style that blends multiple approaches.',
    signatureAnswers: pickSignatureAnswers(answers),
    allStyles: computeAllStyles(scores),
    styleBreakdown: buildBreakdown(scores, style),
  };
}

function rankDims(scores: ApperceptionScore): ApperceptionAxis[] {
  return [...DIMS].sort((a, b) => {
    // Sort by distance from 0.5 (decisiveness), then by raw value
    const da = Math.abs(scores[a] - 0.5);
    const db = Math.abs(scores[b] - 0.5);
    if (db !== da) return db - da;
    return scores[b] - scores[a];
  });
}

function pickSignatureAnswers(answers: ApperceptionAnswer[]): string[] {
  const byId = new Map(apperceptionQuestions.map((q) => [q.id, q]));
  const hits: Array<{ rendered: string; mag: number }> = [];

  for (const ans of answers) {
    const q = byId.get(ans.questionId);
    if (!q) continue;
    if (q.type === 'likert' && ans.type === 'likert') {
      const aw = LIKERT_ANSWER_WEIGHTS[ans.position];
      if (aw === undefined) continue;
      // Use the first dim with a non-zero weight as the primary signal
      for (const d of DIMS) {
        const w = q.weights[d];
        if (typeof w !== 'number') continue;
        const contrib = Math.abs(aw * w);
        if (contrib > 0) {
          const label = LIKERT_LABELS[ans.position];
          hits.push({ rendered: `you ${label} that "${q.stem}"`, mag: contrib });
          break;
        }
      }
    } else if (q.type === 'forced' && ans.type === 'forced') {
      const opt = q.a_options[ans.optionIndex];
      if (!opt) continue;
      hits.push({ rendered: `you picked "${opt.label}" on "${q.stem}"`, mag: 1.0 });
    }
  }

  return hits.sort((a, b) => b.mag - a.mag).slice(0, 3).map((h) => h.rendered);
}

function computeAllStyles(scores: ApperceptionScore): Array<{ name: string; match: number }> {
  const entries: Array<{ name: string; match: number }> = [];
  for (const [key, name] of Object.entries(styleNames)) {
    const expectedC = key[0] === 'E' ? 1 : 0;
    const expectedR = key[1] === 'R' ? 1 : 0;
    const expectedS = key[2] === 'S' ? 1 : 0;
    // Euclidean distance in 3D space, inverted to a match %
    const dist = Math.sqrt(
      (scores.concrete - expectedC) ** 2 +
      (scores.reflective - expectedR) ** 2 +
      (scores.sequential - expectedS) ** 2,
    );
    const maxDist = Math.sqrt(3); // max possible (all three from 0↔1)
    const match = Math.round((1 - dist / maxDist) * 100);
    entries.push({ name, match });
  }
  return entries.sort((a, b) => b.match - a.match);
}

function buildBreakdown(scores: ApperceptionScore, style: ApperceptionStyleResult): string {
  const dimLabel: Record<ApperceptionAxis, string> = {
    concrete: 'concrete↔abstract',
    reflective: 'reflective↔active',
    sequential: 'sequential↔integrative',
  };
  const parts = DIMS.map((d) => {
    const high = scores[d] > 0.5;
    const pct = Math.round(Math.abs(scores[d] - 0.5) * 2 * 100);
    const pole = high
      ? poleLabels[d].high
      : poleLabels[d].low;
    return `${dimLabel[d]}: leans ${pole} (${pct}%)`;
  });
  const displayName = style.blended ? `Leaning ${style.style}` : style.style;
  return `${parts.join('; ')}. style: ${displayName} (${style.confidence} fit).`;
}

const poleLabels: Record<ApperceptionAxis, { high: string; low: string }> = {
  concrete: { high: 'example-first', low: 'principle-first' },
  reflective: { high: 'think-before-acting', low: 'learn-by-doing' },
  sequential: { high: 'step-by-step', low: 'big-picture-first' },
};

// ---------- Static narratives (placeholder — LLM narratives override in gated tier) ----------

export const styleNarratives: Record<
  string,
  { summary: string; blindSpot: string }
> = {
  Architect: {
    summary:
      "you want examples, a plan, and a clear sequence. you learn by seeing something concrete, thinking it through, and following the steps in order. structure isn't a constraint — it's how you get oriented.",
    blindSpot:
      "you can spend too long building the blueprint. sometimes you need to build something, even if it's wrong, to discover what you're actually trying to make.",
  },
  Practitioner: {
    summary:
      "you want to see it done, then do it yourself. examples get you oriented, structured walkthroughs keep you on track, but the real learning happens when your hands are on the thing.",
    blindSpot:
      "you can mistake doing for understanding. stopping to ask why something works can save you from building the same thing three times.",
  },
  Cartographer: {
    summary:
      "you want to see a concrete case, think it through, and understand the whole landscape. you start with an example but immediately zoom out — how does this fit into the bigger picture?",
    blindSpot:
      "you can get lost in the map. sometimes the right move is to pick a path and walk it, even without full visibility.",
  },
  Hacker: {
    summary:
      "show me, then let me explore. you want a concrete starting point and the freedom to roam. you learn by building things and breaking things and building them again.",
    blindSpot:
      "you can skip the manual entirely. sometimes the thing you're trying to figure out is explained in the paragraph you didn't read.",
  },
  Theorist: {
    summary:
      "you want the rule, time to think, and a logical build-up from first principles. the framework matters more than the example — once you have the principle, you can derive the examples yourself.",
    blindSpot:
      "you can live in the framework. principles without practice can feel like understanding without actually being able to do the thing.",
  },
  Sprinter: {
    summary:
      "give me the principle, let me run, and give me a starting line. you learn fast by applying the rule immediately, with just enough structure to know where to begin.",
    blindSpot:
      "speed can outpace understanding. the fastest path sometimes skips the thing you actually needed to learn.",
  },
  Navigator: {
    summary:
      "you want frameworks, time to think deeply, and the full landscape visible. you orient by understanding the whole system — individual facts are secondary to the shape they form together.",
    blindSpot:
      "you can keep navigating without ever landing. sometimes the thing you need is to commit to one path and see where it leads.",
  },
  Builder: {
    summary:
      "you want the rule, you learn by doing, and you want the whole system upfront. you build from first principles, hands-on, with the architecture in mind from the start.",
    blindSpot:
      "you can overbuild. the architecture in your head is sometimes larger than the problem in front of you.",
  },
};
