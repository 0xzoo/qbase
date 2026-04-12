// bartlet — canonical 15-question bank.
//
// Ported from docs/quizzes/bartlet/v2-questions.ts. The worker doesn't need the
// full qbase Query/taxonomy shape, so the type is inlined to just what the
// scorer and snap renderer consume.
//
// Two dimensions:
//   orientation: Players (−1) ←→ World (+1)
//   engagement:  Interacting (−1) ←→ Acting (+1)
//
//   Achiever   = (+orientation, +engagement)  ♦
//   Explorer   = (+orientation, −engagement)  ♠
//   Killer     = (−orientation, +engagement)  ♣
//   Socializer = (−orientation, −engagement)  ♥

export type BartletAxis = 'orientation' | 'engagement';

export interface BartletWeights {
  orientation?: number;
  engagement?: number;
}

export interface BartletOption {
  label: string;
  weights: BartletWeights;
}

export interface BartletQuestion {
  id: string;
  stem: string;
  // Stored for future parity with qbase query types; the snap renders all as mc.
  type: 'mc' | 'scale';
  a_options: BartletOption[];
  probes: BartletAxis[];
}

export const bartletDimensions = [
  { name: 'orientation', negative: 'Players', positive: 'World' },
  { name: 'engagement', negative: 'Interacting', positive: 'Acting' },
] as const;

export const bartletQuestions: readonly BartletQuestion[] = [
  {
    id: 'q_bartlet_not_enough',
    stem: "what's more true?",
    type: 'scale',
    a_options: [
      { label: 'not enough quality content', weights: { orientation: -0.8, engagement: -0.4 } },
      { label: 'not enough quality apps', weights: { orientation: +0.8, engagement: -0.4 } },
    ],
    probes: ['orientation'],
  },
  {
    id: 'q_bartlet_innit_for',
    stem: 'innit for',
    type: 'mc',
    a_options: [
      { label: 'the tech', weights: { orientation: +0.9, engagement: -0.6 } },
      { label: 'the bag', weights: { orientation: -0.6, engagement: +0.9 } },
    ],
    probes: ['orientation', 'engagement'],
  },
  {
    id: 'q_bartlet_ratio_or_qc',
    stem: 'which would you enjoy more?',
    type: 'mc',
    a_options: [
      { label: 'ratio-ing a bad take', weights: { orientation: -0.5, engagement: +0.9 } },
      { label: 'starting a qc chain', weights: { orientation: -0.7, engagement: -0.7 } },
    ],
    probes: ['engagement'],
  },
  {
    id: 'q_bartlet_v_or_dan',
    stem: 'which would you rather?',
    type: 'mc',
    a_options: [
      { label: 'horsefacts liked your cast', weights: { orientation: +0.8, engagement: -0.5 } },
      { label: 'Dan liked your cast', weights: { orientation: +0.2, engagement: +0.9 } },
    ],
    probes: ['engagement'],
  },
  {
    id: 'q_bartlet_follower_or_frens',
    stem: 'which would you rather be measured by?',
    type: 'mc',
    a_options: [
      { label: 'your follower count', weights: { orientation: +0.3, engagement: +0.9 } },
      { label: 'the frens you have made', weights: { orientation: -0.9, engagement: -0.6 } },
    ],
    probes: ['orientation', 'engagement'],
  },
  {
    id: 'q_bartlet_sell_or_leaderboard',
    stem: 'which feels better?',
    type: 'mc',
    a_options: [
      { label: 'top 10 on the leaderboard', weights: { orientation: +0.6, engagement: +0.9 } },
      { label: 'selling the top', weights: { orientation: -0.7, engagement: +0.9 } },
    ],
    probes: ['orientation'],
  },
  {
    id: 'q_bartlet_community_or_frame',
    stem: 'which would you enjoy more?',
    type: 'mc',
    a_options: [
      { label: 'building a community', weights: { orientation: -0.8, engagement: -0.3 } },
      { label: 'building a miniapp', weights: { orientation: +0.8, engagement: -0.3 } },
    ],
    probes: ['orientation'],
  },
  {
    id: 'q_bartlet_hear_or_block',
    stem: 'in a disagreement, you usually',
    type: 'mc',
    a_options: [
      { label: 'hear them out', weights: { orientation: -0.7, engagement: -0.8 } },
      { label: 'block/mute', weights: { orientation: -0.5, engagement: +0.9 } },
    ],
    probes: ['engagement'],
  },
  {
    id: 'q_bartlet_thread_or_qc',
    stem: 'which do you enjoy more?',
    type: 'mc',
    a_options: [
      { label: 'deep reply threads', weights: { orientation: -0.8, engagement: -0.6 } },
      { label: 'quotecasting', weights: { orientation: +0.1, engagement: +0.8 } },
    ],
    probes: ['orientation', 'engagement'],
  },
  {
    id: 'q_bartlet_score_or_docs',
    stem: 'snapchain just dropped a new rewards algo. first thing you do?',
    type: 'mc',
    a_options: [
      { label: 'check your score', weights: { orientation: +0.2, engagement: +0.9 } },
      { label: 'read the full post', weights: { orientation: +0.9, engagement: -0.7 } },
    ],
    probes: ['engagement'],
  },
  {
    id: 'q_bartlet_memecoins_or_utility',
    stem: 'what we buying?',
    type: 'mc',
    a_options: [
      { label: 'memecoins', weights: { orientation: -0.6, engagement: +0.7 } },
      { label: 'utility coins', weights: { orientation: +0.8, engagement: -0.4 } },
    ],
    probes: ['orientation', 'engagement'],
  },
  {
    id: 'q_bartlet_rank_when',
    stem: 'happy with your leaderboard rank when',
    type: 'mc',
    a_options: [
      { label: 'you pass a number', weights: { orientation: +0.6, engagement: +0.8 } },
      { label: 'you pass a rival', weights: { orientation: -0.8, engagement: +0.8 } },
    ],
    probes: ['orientation'],
  },
  {
    id: 'q_bartlet_beefs_count',
    stem: 'fc beefs you have going right now',
    type: 'mc',
    a_options: [
      { label: 'none, i keep it chill', weights: { orientation: +0.2, engagement: -0.4 } },
      { label: 'a few running', weights: { orientation: -0.6, engagement: +0.9 } },
    ],
    probes: ['engagement'],
  },
  {
    id: 'q_bartlet_channels_owned',
    stem: 'channels you own or moderate',
    type: 'mc',
    a_options: [
      { label: 'none', weights: { orientation: 0.0, engagement: 0.0 } },
      { label: 'a few', weights: { orientation: -0.8, engagement: -0.5 } },
    ],
    probes: ['orientation'],
  },
  // Calibration: detect random-clickers. Not scored.
  {
    id: 'q_bartlet_calibration_active',
    stem: 'have you cast in the last week?',
    type: 'mc',
    a_options: [
      { label: 'yes', weights: {} },
      { label: 'no', weights: {} },
    ],
    probes: [],
  },
];

export const BARTLET_LENGTH = bartletQuestions.length;
