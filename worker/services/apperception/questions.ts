// apperception — 21-question cognitive style bank.
//
// Three bipolar dimensions (locked 2026-05-21, see docs/quizzes/apperception/SPEC.md §3):
//   Concrete    — example-first (high) ↔ principle-first (low)
//   Reflective  — think-before-acting (high) ↔ learn-by-doing (low)
//   Sequential  — step-by-step (high) ↔ big-picture-first (low)
//
// Each dim produces a scalar 0-1 where 1 = strong high-end preference,
// 0 = strong low-end preference, 0.5 = no strong leaning.
//
// Question mix:
//   15 Likert       (5-point: SD/D/N/A/SA → answer_weight {-2,-1,0,+1,+2})
//    6 forced       (pick A or B, within-dimension — no cross-dim pitting)

export type ApperceptionAxis = 'concrete' | 'reflective' | 'sequential';

export interface ApperceptionWeights {
  concrete?: number;
  reflective?: number;
  sequential?: number;
}

export interface ApperceptionOption {
  label: string;
  weights: ApperceptionWeights;
}

export type ApperceptionQuestion =
  | {
      id: string;
      stem: string;
      type: 'likert';
      weights: ApperceptionWeights;
      probes: ApperceptionAxis[];
    }
  | {
      id: string;
      stem: string;
      type: 'forced';
      a_options: [ApperceptionOption, ApperceptionOption];
      probes: ApperceptionAxis[];
    };

export const apperceptionDimensions = [
  { name: 'concrete' as const, label: 'Concrete' },
  { name: 'reflective' as const, label: 'Reflective' },
  { name: 'sequential' as const, label: 'Sequential' },
];

export const LIKERT_LABELS = [
  'strongly disagree',
  'disagree',
  'neutral',
  'agree',
  'strongly agree',
] as const;

export const LIKERT_ANSWER_WEIGHTS = [-2, -1, 0, +1, +2] as const;

// Order: no consecutive same-dim items, reverse-keyed Likerts spaced,
// forced-choice distributed throughout. Annotations show (dim, polarity).
export const apperceptionQuestions: readonly ApperceptionQuestion[] = [
  // --- C1 (+concrete) ---
  {
    id: 'q_apperception_example_over_theory',
    stem: "i'd rather see an example than hear a theory",
    type: 'likert',
    weights: { concrete: +0.8 },
    probes: ['concrete'],
  },
  // --- R2 (−reflective / reverse) ---
  {
    id: 'q_apperception_try_new',
    stem: "i'll try something new just to see what happens",
    type: 'likert',
    weights: { reflective: -0.8 },
    probes: ['reflective'],
  },
  // --- S1 (+sequential) ---
  {
    id: 'q_apperception_directions_order',
    stem: "i'd rather follow turn-by-turn directions than see the whole map and find my own way",
    type: 'likert',
    weights: { sequential: +0.8 },
    probes: ['sequential'],
  },
  // --- C6 forced (concrete within-dimension) ---
  {
    id: 'q_apperception_stuck',
    stem: "when i'm stuck, i",
    type: 'forced',
    a_options: [
      { label: 'look for how other people solved something similar', weights: { concrete: +0.8 } },
      { label: 'step back and figure out which general rule applies', weights: { concrete: -0.8 } },
    ],
    probes: ['concrete'],
  },
  // --- C4 (−concrete / reverse) ---
  {
    id: 'q_apperception_skim_stories',
    stem: 'when i read something, i skim past the stories looking for the main point',
    type: 'likert',
    weights: { concrete: -0.8 },
    probes: ['concrete'],
  },
  // --- R3 (+reflective) ---
  {
    id: 'q_apperception_weighing_tradeoffs',
    stem: "when a group is debating options, i'm usually the one quietly weighing the trade-offs",
    type: 'likert',
    weights: { reflective: +0.7 },
    probes: ['reflective'],
  },
  // --- S4 (−sequential / reverse) ---
  {
    id: 'q_apperception_just_what_happened',
    stem: 'when a friend starts a story with backstory, i ask them to just tell me what happened',
    type: 'likert',
    weights: { sequential: -0.8 },
    probes: ['sequential'],
  },
  // --- R6 forced (reflective within-dimension) ---
  {
    id: 'q_apperception_plan_trip',
    stem: 'when planning a trip, i',
    type: 'forced',
    a_options: [
      { label: 'research hotels, routes, and restaurants in advance', weights: { reflective: +0.8 } },
      { label: 'book the first night and figure out the rest as i go', weights: { reflective: -0.8 } },
    ],
    probes: ['reflective'],
  },
  // --- C3 (+concrete) ---
  {
    id: 'q_apperception_demo_over_lecture',
    stem: 'a good demonstration teaches me more than a good lecture',
    type: 'likert',
    weights: { concrete: +0.7 },
    probes: ['concrete'],
  },
  // --- R5 (−reflective / reverse) ---
  {
    id: 'q_apperception_no_instructions',
    stem: "hand me a gadget with no instructions and i'll figure it out by pressing things",
    type: 'likert',
    weights: { reflective: -0.8 },
    probes: ['reflective'],
  },
  // --- S2 (−sequential / reverse) ---
  {
    id: 'q_apperception_big_picture_first',
    stem: "the details don't stick for me until i've seen the big picture",
    type: 'likert',
    weights: { sequential: -0.7 },
    probes: ['sequential'],
  },
  // --- S7 forced (sequential within-dimension) ---
  {
    id: 'q_apperception_online_course',
    stem: 'taking an online course, i prefer',
    type: 'forced',
    a_options: [
      { label: 'modules that unlock in order, each building on the last', weights: { sequential: +0.8 } },
      { label: "everything available at once — i'll jump to what interests me", weights: { sequential: -0.8 } },
    ],
    probes: ['sequential'],
  },
  // --- C2 (−concrete / reverse) ---
  {
    id: 'q_apperception_rule_before_examples',
    stem: 'i usually want the rule or framework before the examples',
    type: 'likert',
    weights: { concrete: -0.8 },
    probes: ['concrete'],
  },
  // --- R1 (+reflective) ---
  {
    id: 'q_apperception_ikea_manual',
    stem: 'i read the IKEA manual before i touch a single screw',
    type: 'likert',
    weights: { reflective: +0.8 },
    probes: ['reflective'],
  },
  // --- S3 (+sequential) ---
  {
    id: 'q_apperception_start_to_finish',
    stem: "i want the tutorial to walk me from start to finish, in exact order",
    type: 'likert',
    weights: { sequential: +0.8 },
    probes: ['sequential'],
  },
  // --- C7 forced (concrete within-dimension) ---
  {
    id: 'q_apperception_learn_skill',
    stem: 'i learn a new skill best by',
    type: 'forced',
    a_options: [
      { label: 'watching someone do it, then trying', weights: { concrete: +0.8 } },
      { label: 'understanding the principles, then practicing', weights: { concrete: -0.8 } },
    ],
    probes: ['concrete'],
  },
  // --- R4 (+reflective / cost-framed) ---
  {
    id: 'q_apperception_about_to_start',
    stem: "i've stayed 'about to start' on things for weeks because i keep finding edge cases to plan for",
    type: 'likert',
    weights: { reflective: +0.7 },
    probes: ['reflective'],
  },
  // --- S5 (−sequential / reverse) ---
  {
    id: 'q_apperception_jumping_around',
    stem: "halfway through a long article i realize i've been jumping around, building my own map",
    type: 'likert',
    weights: { sequential: -0.8 },
    probes: ['sequential'],
  },
  // --- C5 (+concrete) ---
  {
    id: 'q_apperception_best_show_me',
    stem: 'if someone wants to teach me something, the best thing they can do is show me',
    type: 'likert',
    weights: { concrete: +0.7 },
    probes: ['concrete'],
  },
  // --- R7 forced (reflective within-dimension) ---
  {
    id: 'q_apperception_learn_new_skill',
    stem: 'when learning a new skill, i',
    type: 'forced',
    a_options: [
      { label: 'want to understand the techniques before making anything', weights: { reflective: +0.8 } },
      { label: "want to make something right away, even if it's not good yet", weights: { reflective: -0.8 } },
    ],
    probes: ['reflective'],
  },
  // --- S6 forced (sequential within-dimension) ---
  {
    id: 'q_apperception_large_project',
    stem: "dropped into a large project, i'd rather",
    type: 'forced',
    a_options: [
      { label: 'trace one thing end-to-end through the system', weights: { sequential: +0.8 } },
      { label: 'read the architecture overview to see how everything connects', weights: { sequential: -0.8 } },
    ],
    probes: ['sequential'],
  },
];

export const APPERCEPTION_LENGTH = apperceptionQuestions.length;
