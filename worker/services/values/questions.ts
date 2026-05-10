// values — canonical 22-question bank.
//
// Five unipolar dimensions (locked 2026-05-09, see docs/quizzes/values/SPEC.md §3):
//   Autonomy     — acting on own judgment, independence, self-direction
//   Care         — weighting others' welfare, empathy, in-group preservation
//   Openness     — welcoming novelty, change, curiosity, comfort with uncertainty
//   Mastery      — competence, craft, becoming better at the thing
//   Universalism — weighting all-of-humanity outcomes, environment, justice
//
// Each dim is scored 0-1 independently; respondents can score high on multiple.
//
// Question mix (matches SPEC §4):
//   15 Likert       (5-point: SD/D/N/A/SA → answer_weight {-2,-1,0,+1,+2})
//    3 forced       (pick A or B between values in tension)
//    3 open         (LLM-scored across all dims at result time)
//
// Each Likert dim has at least one reverse-keyed item to reduce acquiescence bias.
// No calibration item — the 3 open-text questions already filter random-clickers.

export type ValuesAxis = 'autonomy' | 'care' | 'openness' | 'mastery' | 'universalism';

export interface ValuesWeights {
  autonomy?: number;
  care?: number;
  openness?: number;
  mastery?: number;
  universalism?: number;
}

// `forced` and `open` shapes mirror bartlet's option-list pattern; `likert`
// emits a fixed 5-point scale, so the per-question weights live on the
// statement itself and the answer's position on the scale provides the sign.
export interface ValuesOption {
  label: string;
  weights: ValuesWeights;
}

export type ValuesQuestion =
  | {
      id: string;
      stem: string;
      type: 'likert';
      // Weights applied at answer-weight = +1 (Strongly agree). Negated for
      // disagree side. Reverse-keyed items have negative dim weights.
      weights: ValuesWeights;
      probes: ValuesAxis[];
    }
  | {
      id: string;
      stem: string;
      type: 'forced';
      a_options: [ValuesOption, ValuesOption];
      probes: ValuesAxis[];
    }
  | {
      id: string;
      stem: string;
      type: 'open';
      // Open-text answers are LLM-classified at result time. No static weights.
      probes: ValuesAxis[];
    };

export const valuesDimensions = [
  { name: 'autonomy', label: 'Autonomy' },
  { name: 'care', label: 'Care' },
  { name: 'openness', label: 'Openness' },
  { name: 'mastery', label: 'Mastery' },
  { name: 'universalism', label: 'Universalism' },
] as const;

export const LIKERT_LABELS = [
  'strongly disagree',
  'disagree',
  'neutral',
  'agree',
  'strongly agree',
] as const;

// Likert option weights, indexed by position 0-4. Multiply per-question dim
// weights by this scalar to get the contribution.
export const LIKERT_ANSWER_WEIGHTS = [-2, -1, 0, +1, +2] as const;

// Order is deterministic and jumbled: no consecutive items share a primary
// dim, reverse-keyed Likert items are spaced (no two adjacent), forced-choices
// are evenly distributed (positions 6/12/18), and open-text questions land
// at the end as the cognitive-mode shift. Annotations on the right show
// (primary dim, +/- direction or `forced`/`open`).
export const valuesQuestions: readonly ValuesQuestion[] = [
  {
    id: 'q_values_strange_new', // O+
    stem: "i'd take a strange new opportunity over a known good one",
    type: 'likert',
    weights: { openness: +0.9 },
    probes: ['openness'],
  },
  {
    id: 'q_values_decisions_land', // C+
    stem: 'i think a lot about how my decisions land on the people close to me',
    type: 'likert',
    weights: { care: +0.9 },
    probes: ['care'],
  },
  {
    id: 'q_values_group_drift', // A- (reverse)
    stem: 'if a group decides one way and i think differently, i tend to go with the group',
    type: 'likert',
    weights: { autonomy: -0.7 },
    probes: ['autonomy'],
  },
  {
    id: 'q_values_after_us', // U+
    stem: 'what we leave behind for the people coming after us matters to how i live',
    type: 'likert',
    weights: { universalism: +0.8 },
    probes: ['universalism'],
  },
  {
    id: 'q_values_one_thing_well', // M+
    stem: "i'd rather get really good at one thing than be okay at many",
    type: 'likert',
    weights: { mastery: +0.8 },
    probes: ['mastery'],
  },
  {
    id: 'q_values_principles_v_peace', // forced (A↔C)
    stem: 'your principles say no but your friends say yes. you usually',
    type: 'forced',
    a_options: [
      { label: 'stick with your principles', weights: { autonomy: +0.8, care: -0.4 } },
      { label: 'go along to keep the peace', weights: { care: +0.7, autonomy: -0.6 } },
    ],
    probes: ['autonomy', 'care'],
  },
  {
    id: 'q_values_routines_over_exp', // O- (reverse)
    stem: 'i prefer routines that work over experiments that might not',
    type: 'likert',
    weights: { openness: -0.8 },
    probes: ['openness'],
  },
  {
    id: 'q_values_shrink_plans', // C+
    stem: "i'd shrink my own plans before i'd let down someone close",
    type: 'likert',
    weights: { care: +0.8, mastery: -0.4 },
    probes: ['care', 'mastery'],
  },
  {
    id: 'q_values_unsupervised_best', // A+
    stem: 'the best work i do is when nobody is checking on me',
    type: 'likert',
    weights: { autonomy: +0.8 },
    probes: ['autonomy'],
  },
  {
    id: 'q_values_work_over_recognition', // M+
    stem: 'the work itself is more rewarding to me than the recognition for it',
    type: 'likert',
    weights: { mastery: +0.7, autonomy: +0.2 },
    probes: ['mastery'],
  },
  {
    id: 'q_values_my_own_first', // U- (reverse)
    // Targets moral-circle prioritization: agreement endorses a hierarchy
    // (own group before others), which directly opposes Universalism's
    // equal-consideration claim. People high on Care + Universalism still
    // reject the "first" framing, so it discriminates Universalism cleanly.
    stem: 'i look out for my own first',
    type: 'likert',
    weights: { universalism: -0.7 },
    probes: ['universalism'],
  },
  {
    id: 'q_values_year_off', // forced (M↔O)
    stem: 'you have a year off. you spend it',
    type: 'forced',
    a_options: [
      { label: "deep on one craft you've been wanting to master", weights: { mastery: +0.9, openness: -0.2 } },
      { label: 'exploring as many new things as possible', weights: { openness: +0.9, mastery: -0.3 } },
    ],
    probes: ['mastery', 'openness'],
  },
  {
    id: 'q_values_worse_for_fair', // U+
    stem: "i'd accept a worse outcome for myself if it produced a fairer one overall",
    type: 'likert',
    weights: { universalism: +0.8, mastery: -0.3 },
    probes: ['universalism', 'mastery'],
  },
  {
    id: 'q_values_decent_move_on', // M- (reverse)
    stem: "once i'm decent at something, i tend to move on",
    type: 'likert',
    weights: { mastery: -0.7 },
    probes: ['mastery'],
  },
  {
    id: 'q_values_uncertainty_energizes', // O+
    stem: 'uncertainty energizes me more than it stresses me',
    type: 'likert',
    weights: { openness: +0.8 },
    probes: ['openness'],
  },
  {
    id: 'q_values_hard_truth', // C- (reverse)
    stem: "i'd rather tell someone close a hard truth than smooth it over",
    type: 'likert',
    weights: { care: -0.6, autonomy: +0.5 },
    probes: ['care', 'autonomy'],
  },
  {
    id: 'q_values_own_mistakes', // A+
    stem: "i'd rather make my own mistakes than follow someone else's plan",
    type: 'likert',
    weights: { autonomy: +0.9 },
    probes: ['autonomy'],
  },
  {
    id: 'q_values_give_to', // forced (C↔U)
    stem: "given a fixed amount to give away, you'd rather it went to",
    type: 'forced',
    a_options: [
      { label: 'people in your immediate community', weights: { care: +0.8, universalism: -0.2 } },
      { label: "people you'll never meet who need it more", weights: { universalism: +0.9, care: -0.3 } },
    ],
    probes: ['care', 'universalism'],
  },
  {
    id: 'q_values_hard_right', // open
    stem: "describe a decision you made recently that felt right but wasn't easy.",
    type: 'open',
    probes: ['autonomy', 'care', 'mastery', 'universalism'],
  },
  {
    id: 'q_values_unpopular_belief', // open
    stem: "what's something you believe that most people you know don't?",
    type: 'open',
    probes: ['autonomy', 'openness', 'universalism'],
  },
  {
    id: 'q_values_fix_world', // open
    stem: 'if you could fix one thing about how the world works, what would it be?',
    type: 'open',
    probes: ['universalism', 'care', 'openness'],
  },
];

export const VALUES_LENGTH = valuesQuestions.length;
