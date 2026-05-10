// values — scoring across 5 unipolar dims, free + paid tier results.
//
// Unipolar = each dim scored 0-1 independently. Compare to bartlet's 2-axis
// quadrant model — algorithmically much simpler:
//   1. Per dim: weighted average of (answer_weight × dim_weight) signals,
//      normalized into [-1, +1] then mapped to [0, 1].
//   2. Dominant dim wins the badge ("Autonomy-led"); runner-up is the
//      "secondary" callout. No formal hybrid taxonomy — radar shape carries
//      the multi-dim signal visually.
//
// Open-text answers are NOT scored here — they need an LLM classification
// pass (classifyOpenText, deferred to AIService integration). blendOpenText
// combines the Likert+forced score with that LLM output at result-render
// time, per SPEC §5 (default 0.7 Likert + 0.3 open-text).

import {
  valuesQuestions,
  LIKERT_ANSWER_WEIGHTS,
  LIKERT_LABELS,
  type ValuesAxis,
} from './questions';

const DIMS: readonly ValuesAxis[] = [
  'autonomy',
  'care',
  'openness',
  'mastery',
  'universalism',
];

export type ValuesAnswer =
  | { questionId: string; type: 'likert'; position: number }   // 0..4 (SD..SA)
  | { questionId: string; type: 'forced'; optionIndex: number } // 0 | 1
  | { questionId: string; type: 'open'; text: string };

export interface ValuesScore {
  autonomy: number;
  care: number;
  openness: number;
  mastery: number;
  universalism: number;
  // 0-1, fraction of scorable items (Likert + forced) actually answered.
  confidence: number;
}

const NEUTRAL_SCORE: ValuesScore = {
  autonomy: 0.5,
  care: 0.5,
  openness: 0.5,
  mastery: 0.5,
  universalism: 0.5,
  confidence: 0,
};

const SCORABLE_COUNT = valuesQuestions.filter(
  (q) => q.type === 'likert' || q.type === 'forced',
).length;

// Max |answer_weight| for Likert (= 2, the "Strongly" ends). Forced-choice
// answer weight is 1 (the user picked this option, full strength).
const LIKERT_MAX_AW = 2;
const FORCED_AW = 1;

export function scoreValues(answers: ValuesAnswer[]): ValuesScore {
  const byId = new Map(valuesQuestions.map((q) => [q.id, q]));

  const num: Record<ValuesAxis, number> = {
    autonomy: 0, care: 0, openness: 0, mastery: 0, universalism: 0,
  };
  const den: Record<ValuesAxis, number> = {
    autonomy: 0, care: 0, openness: 0, mastery: 0, universalism: 0,
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
        // Normalizer: max |weight| across both options on this question, so
        // the per-item contribution to den equals the maximum the user could
        // have signaled in either direction.
        const maxAbs = Math.max(
          Math.abs(q.a_options[0].weights[d] ?? 0),
          Math.abs(q.a_options[1].weights[d] ?? 0),
        );
        den[d] += FORCED_AW * maxAbs;
      }
    }
    // open-text answers are skipped here; classifyOpenText handles them.
  }

  const score: ValuesScore = { ...NEUTRAL_SCORE };
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

// Combine Likert+forced score with an LLM-derived open-text score.
// Per SPEC §5 default is 0.7 Likert + 0.3 open-text.
export function blendOpenText(
  likert: ValuesScore,
  openText: Omit<ValuesScore, 'confidence'>,
  likertWeight = 0.7,
): ValuesScore {
  const ow = 1 - likertWeight;
  return {
    autonomy: clamp01(likert.autonomy * likertWeight + openText.autonomy * ow),
    care: clamp01(likert.care * likertWeight + openText.care * ow),
    openness: clamp01(likert.openness * likertWeight + openText.openness * ow),
    mastery: clamp01(likert.mastery * likertWeight + openText.mastery * ow),
    universalism: clamp01(likert.universalism * likertWeight + openText.universalism * ow),
    confidence: likert.confidence,
  };
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

// ---------- Free tier ----------

export interface ValuesFreeTierResult {
  scores: ValuesScore;
  dominant: ValuesAxis;
  secondary: ValuesAxis;
  badge: string;              // e.g. "Autonomy-led"
  summary: string;            // 1 paragraph keyed to dominant
  signatureAnswers: string[]; // 3 strongest contributions to the dominant dim
}

export function freeTierResult(
  answers: ValuesAnswer[],
  openText?: Omit<ValuesScore, 'confidence'> | null,
): ValuesFreeTierResult {
  let scores = scoreValues(answers);
  if (openText) scores = blendOpenText(scores, openText);
  const ranked = rankDims(scores);
  const dominant = ranked[0];

  return {
    scores,
    dominant,
    secondary: ranked[1],
    badge: `${dimLabels[dominant]}-led`,
    summary: dimNarratives[dominant].summary,
    signatureAnswers: pickSignatureAnswers(answers, dominant),
  };
}

// ---------- Paid tier ----------
// Most of the paid tier is LLM-driven (per-dim narratives + context-card
// markdown). The scorer here returns the blended scores + ranking; the
// result page calls the AI service to fill in narrative content.

export interface ValuesPaidTierResult extends ValuesFreeTierResult {
  ranked: ValuesAxis[]; // all 5 dims, dominant → least
}

export function paidTierResult(
  answers: ValuesAnswer[],
  openText?: Omit<ValuesScore, 'confidence'>,
): ValuesPaidTierResult {
  let scores = scoreValues(answers);
  if (openText) scores = blendOpenText(scores, openText);
  const ranked = rankDims(scores);
  const dominant = ranked[0];

  return {
    scores,
    dominant,
    secondary: ranked[1],
    badge: `${dimLabels[dominant]}-led`,
    summary: dimNarratives[dominant].summary,
    signatureAnswers: pickSignatureAnswers(answers, dominant),
    ranked,
  };
}

function rankDims(scores: ValuesScore): ValuesAxis[] {
  return [...DIMS].sort((a, b) => scores[b] - scores[a]);
}

function pickSignatureAnswers(answers: ValuesAnswer[], dim: ValuesAxis): string[] {
  const byId = new Map(valuesQuestions.map((q) => [q.id, q]));
  const hits: Array<{ rendered: string; mag: number }> = [];

  for (const ans of answers) {
    const q = byId.get(ans.questionId);
    if (!q) continue;
    if (q.type === 'likert' && ans.type === 'likert') {
      const w = q.weights[dim];
      if (typeof w !== 'number') continue;
      const aw = LIKERT_ANSWER_WEIGHTS[ans.position];
      if (aw === undefined) continue;
      const contrib = aw * w; // sign tells direction toward dim
      if (contrib <= 0) continue;
      const label = LIKERT_LABELS[ans.position];
      hits.push({ rendered: `you ${label} that "${q.stem}"`, mag: contrib });
    } else if (q.type === 'forced' && ans.type === 'forced') {
      const opt = q.a_options[ans.optionIndex];
      if (!opt) continue;
      const w = opt.weights[dim];
      if (typeof w !== 'number' || w <= 0) continue;
      hits.push({ rendered: `you picked "${opt.label}" on "${q.stem}"`, mag: w });
    }
  }

  return hits.sort((a, b) => b.mag - a.mag).slice(0, 3).map((h) => h.rendered);
}

// ---------- Content ----------
// Authored placeholders. Tone-locked enough to ship; final language pass
// belongs with snap copy and the result-page reveal.

const dimLabels: Record<ValuesAxis, string> = {
  autonomy: 'Autonomy',
  care: 'Care',
  openness: 'Openness',
  mastery: 'Mastery',
  universalism: 'Universalism',
};

export const dimNarratives: Record<
  ValuesAxis,
  { summary: string; blindSpot: string }
> = {
  autonomy: {
    summary:
      "your defaults run on your own judgment. you'd rather make the call yourself and learn from it than execute someone else's plan well — independence isn't a posture, it's how you actually navigate.",
    blindSpot:
      "you can underweight what you'd actually learn from someone else's experience. independence gets lonely if you never let anyone guide you.",
  },
  care: {
    summary:
      "the people closest to you factor into almost every choice you make. relationships aren't separate from work or values — they're the ground all of it sits on.",
    blindSpot:
      "your own ambitions can feel optional next to other people's needs. taking yourself seriously sometimes requires disappointing them.",
  },
  openness: {
    summary:
      "novelty pulls on you. a strange new direction beats a known good one, and uncertainty energizes more than it stresses. you trust the unfolding.",
    blindSpot:
      "you start more than you finish. the next thing is often more interesting than seeing the current thing through.",
  },
  mastery: {
    summary:
      "you want to get good at the thing — really good. the practice itself is the reward, and the gap between knowing about something and being able to do it feels meaningful to you.",
    blindSpot:
      "depth costs breadth. you can become illegible to people whose lives don't share the language of the thing you're mastering.",
  },
  universalism: {
    summary:
      "your moral concern extends past the people you know. fairness for strangers, what we leave behind, long-tail consequences — these factor into how you live now.",
    blindSpot:
      "abstract concern can crowd out concrete care. the world is large; the people in front of you are specific.",
  },
};
