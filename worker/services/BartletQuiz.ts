/**
 * Bartlet quiz — 10 MC questions, 2 options each, each option mapped to one
 * of the four Bartlet archetypes (Killer / Achiever / Explorer / Socializer).
 *
 * Scoring: +1 to the mapped archetype for the chosen option.
 *
 * Source: docs/quizzes/bartlet/questions.ts (cleaned subset of `bartletQuerys`).
 * This set is a starting point — iterate on question quality in-place.
 */

export type BartleType = 'Killer' | 'Achiever' | 'Explorer' | 'Socializer';

export interface BartletQuestion {
  id: number;
  stem: string;
  options: [string, string];
  mapping: [BartleType, BartleType];
}

export const BARTLET_QUESTIONS: readonly BartletQuestion[] = [
  {
    id: 1,
    stem: 'What we buying?',
    options: ['memecoins', 'utility coins'],
    mapping: ['Killer', 'Explorer'],
  },
  {
    id: 2,
    stem: 'Which do you enjoy more?',
    options: ['Replying', 'Quotecasting'],
    mapping: ['Socializer', 'Achiever'],
  },
  {
    id: 3,
    stem: "snapchain just dropped, enabling a new rewards algo. what's the first thing you do?",
    options: ['check your score', 'read the docs'],
    mapping: ['Achiever', 'Explorer'],
  },
  {
    id: 4,
    stem: 'Which would you rather:',
    options: ['V liked your cast', 'Dan liked your cast'],
    mapping: ['Explorer', 'Achiever'],
  },
  {
    id: 5,
    stem: 'Innit for',
    options: ['the tech', 'the bag'],
    mapping: ['Explorer', 'Killer'],
  },
  {
    id: 6,
    stem: 'Which would you enjoy more?',
    options: ['Building a community', 'Building a frame'],
    mapping: ['Socializer', 'Explorer'],
  },
  {
    id: 7,
    stem: 'Which feels better?',
    options: ['top 10 on the leaderboard', 'selling the top'],
    mapping: ['Achiever', 'Killer'],
  },
  {
    id: 8,
    stem: 'Which tagline?',
    options: ['make money, then frens', 'make frens, and money'],
    mapping: ['Killer', 'Socializer'],
  },
  {
    id: 9,
    stem: 'Which would you rather be measured by?',
    options: ['Your follower count', "the connections you've made"],
    mapping: ['Achiever', 'Socializer'],
  },
  {
    id: 10,
    stem: "you're happy with your rewards rank when",
    options: ['you rank above some arbitrary number', 'you rank higher than some other user'],
    mapping: ['Achiever', 'Killer'],
  },
];

export const BARTLET_LENGTH = BARTLET_QUESTIONS.length;

export interface BartletScores {
  Killer: number;
  Achiever: number;
  Explorer: number;
  Socializer: number;
}

export function emptyScores(): BartletScores {
  return { Killer: 0, Achiever: 0, Explorer: 0, Socializer: 0 };
}

export function applyAnswer(
  scores: BartletScores,
  questionIndex: number,
  chosenOption: string
): BartletScores {
  const q = BARTLET_QUESTIONS[questionIndex];
  if (!q) return scores;
  const optIdx = q.options.indexOf(chosenOption);
  if (optIdx < 0) return scores;
  const type = q.mapping[optIdx];
  return { ...scores, [type]: scores[type] + 1 };
}

export function dominantType(scores: BartletScores): BartleType {
  const entries: Array<[BartleType, number]> = [
    ['Killer', scores.Killer],
    ['Achiever', scores.Achiever],
    ['Explorer', scores.Explorer],
    ['Socializer', scores.Socializer],
  ];
  entries.sort((a, b) => b[1] - a[1]);
  return entries[0][0];
}

/**
 * URL state: `?qi=<int>&k=&a=&e=&s=`
 * - `qi`: question index. -1 (or absent) = intro, 0..N-1 = question N, N = result.
 * - `k`/`a`/`e`/`s`: running scores (Killer/Achiever/Explorer/Socializer).
 *
 * Scores are embedded in URLs so the quiz is fully stateless and any snap
 * URL is shareable as-is (a completed-result URL shows that user's result).
 */
export function readState(url: URL): { qi: number; scores: BartletScores } {
  const num = (k: string) => {
    const v = parseInt(url.searchParams.get(k) || '', 10);
    return Number.isFinite(v) ? v : 0;
  };
  const qiRaw = url.searchParams.get('qi');
  const qi = qiRaw === null ? -1 : num('qi');
  return {
    qi,
    scores: {
      Killer: num('k'),
      Achiever: num('a'),
      Explorer: num('e'),
      Socializer: num('s'),
    },
  };
}

export function writeStateUrl(
  origin: string,
  qi: number,
  scores: BartletScores
): string {
  const params = new URLSearchParams();
  params.set('qi', String(qi));
  params.set('k', String(scores.Killer));
  params.set('a', String(scores.Achiever));
  params.set('e', String(scores.Explorer));
  params.set('s', String(scores.Socializer));
  return `${origin}/snap/bartle-dev?${params.toString()}`;
}
