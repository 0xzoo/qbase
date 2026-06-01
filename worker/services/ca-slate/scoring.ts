// ca-slate — scoring model.
//
// Pure functions, no I/O. Per-office Euclidean distance, with a per-office
// subset of dimensions and a Q0 party-affiliation filter on the candidate
// pool. Mirrors the persona test in
// make-quiz/scripts/ca-slate-persona-test.py 1:1.
//
// Per-office dim subset rationale: the questions are a shared 13-dim profile,
// but each office cares about a different subset (e.g. AG doesn't care about
// housing, Treasurer doesn't care about crime). Using only relevant dims
// avoids spurious distance from positions the office has no jurisdiction over.

import { CA_SLATE_LENGTH } from './questions';
import {
  type CaSlateAnswer,
  type CaSlateAxis,
  type PartyChoice,
} from './scoring.types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

export type { CaSlateAnswer, CaSlateAxis, PartyChoice } from './scoring.types';

// ─── Likert → position ────────────────────────────────────────────────────
// Slider value 1..5 maps to position 0..4. SA=1.0, A=0.75, N=0.5, D=0.25, SD=0.
export const LIKERT_SCORES = [0.0, 0.25, 0.5, 0.75, 1.0] as const;
export const LIKERT_LABELS = [
  'strongly disagree',
  'disagree',
  'neutral',
  'agree',
  'strongly agree',
] as const;

// ─── Party filter ─────────────────────────────────────────────────────────
// Allowed candidate parties for each Q0 choice. Nonpartisan (NPP) offices
// always show all NPP regardless — but the filter still applies, so e.g. a
// 'rep' user gets R + NPP for the Superintendent race (no D candidates in
// the pool anyway since none are NPP).
//
// dem → D + G + P&F + NPP  (Dem primary, with small left + nonpartisan crossover)
// rep → R + NPP            (Rep primary; Greens are not the R base)
// any → D + R + G + P&F + NPP (no filter)
const PARTY_FILTER: Record<PartyChoice, ReadonlySet<string>> = {
  dem: new Set(['D', 'G', 'P&F', 'NPP']),
  rep: new Set(['R', 'NPP']),
  any: new Set(['D', 'R', 'G', 'P&F', 'NPP']),
};

export type Party = 'D' | 'R' | 'G' | 'P&F' | 'NPP';

export interface Candidate {
  name: string;
  party: Party;
  // Indexes into the 13-dim user vector (see DIM_NAMES below).
  dimIndices: readonly number[];
  // Score per dimIndex (same length).
  scores: readonly number[];
}

export interface Office {
  name: string;
  candidates: readonly Candidate[];
}

export interface OfficeMatch {
  name: string;
  topCandidate: string;
  topParty: Party;
  topAlignment: number;       // 0..1 — fraction match (1 - distance)
  topDistance: number;        // raw Euclidean
  topReason: string;          // 1-line reason (closest dim match)
  allRanked: Array<{
    name: string;
    party: Party;
    distance: number;
    alignment: number;
  }>;
}

// ─── Dim index constants ──────────────────────────────────────────────────
// Mirrors caSlateQuestions order in questions.ts. Index 0..12 maps to:
export const DIM_NAMES: readonly CaSlateAxis[] = [
  'housing',
  'tax',
  'crime',
  'climate',
  'education',
  'healthcare',
  'immigration',
  'limitedGov',
  'dei',
  'fiscal',
  'election',
  'consumer',
  'aipac',
];

// ─── Offices + candidate scores ────────────────────────────────────────────
// Sourced from public positions (CalMatters, Ballotpedia, campaign sites,
// Secretary of State voter guide, media questionnaires, TrackAIPAC for
// federal, news). Full sourcing note in the result-page footer.
//
// Thin candidates (no public platform) → scored 0.5 (neutral) on every dim.
// The user pays for that — they won't match strongly on any profile.

export const OFFICES: readonly Office[] = [
  // ── Governor (all 13 dims) ──
  {
    name: 'Governor',
    candidates: [
      { name: 'Porter (D)',         party: 'D', dimIndices: [0,1,2,3,4,5,6,7,8,9,10,11,12], scores: [0.8, 0.9, 0.3, 0.8, 0.8, 0.7, 0.9, 0.2, 0.9, 0.6, 0.2, 0.9, 0.9] },
      { name: 'Becerra (D)',        party: 'D', dimIndices: [0,1,2,3,4,5,6,7,8,9,10,11,12], scores: [0.6, 0.7, 0.4, 0.6, 0.7, 0.6, 0.7, 0.3, 0.7, 0.4, 0.2, 0.6, 0.7] },
      { name: 'Steyer (D)',         party: 'D', dimIndices: [0,1,2,3,4,5,6,7,8,9,10,11,12], scores: [0.6, 0.8, 0.3, 0.9, 0.6, 0.8, 0.7, 0.2, 0.7, 0.3, 0.2, 0.7, 0.9] },
      { name: 'Mahan (D)',          party: 'D', dimIndices: [0,1,2,3,4,5,6,7,8,9,10,11,12], scores: [0.9, 0.4, 0.5, 0.5, 0.6, 0.4, 0.6, 0.5, 0.5, 0.7, 0.3, 0.5, 0.5] },
      { name: 'Villaraigosa (D)',   party: 'D', dimIndices: [0,1,2,3,4,5,6,7,8,9,10,11,12], scores: [0.7, 0.6, 0.5, 0.6, 0.7, 0.5, 0.6, 0.3, 0.6, 0.4, 0.2, 0.6, 0.6] },
      { name: 'Thurmond (D)',       party: 'D', dimIndices: [0,1,2,3,4,5,6,7,8,9,10,11,12], scores: [0.5, 0.8, 0.3, 0.6, 0.9, 0.7, 0.7, 0.2, 0.7, 0.3, 0.2, 0.7, 0.5] },
      { name: 'Hilton (R)',         party: 'R', dimIndices: [0,1,2,3,4,5,6,7,8,9,10,11,12], scores: [0.7, 0.1, 0.9, 0.1, 0.6, 0.1, 0.1, 0.9, 0.1, 0.5, 0.8, 0.1, 0.1] },
      { name: 'Bianco (R)',         party: 'R', dimIndices: [0,1,2,3,4,5,6,7,8,9,10,11,12], scores: [0.5, 0.1, 0.9, 0.1, 0.5, 0.1, 0.1, 0.8, 0.1, 0.5, 0.7, 0.1, 0.2] },
    ],
  },
  // ── Lt. Governor (all 13 dims) ──
  {
    name: 'Lt. Governor',
    candidates: [
      { name: 'Fryday (D)',         party: 'D', dimIndices: [0,1,2,3,4,5,6,7,8,9,10,11,12], scores: [0.8, 0.7, 0.4, 0.9, 0.8, 0.5, 0.8, 0.2, 0.8, 0.3, 0.2, 0.6, 0.7] },
      { name: 'Ma (D)',             party: 'D', dimIndices: [0,1,2,3,4,5,6,7,8,9,10,11,12], scores: [0.7, 0.7, 0.5, 0.6, 0.7, 0.7, 0.6, 0.3, 0.7, 0.4, 0.2, 0.7, 0.6] },
      { name: 'Tubbs (D)',          party: 'D', dimIndices: [0,1,2,3,4,5,6,7,8,9,10,11,12], scores: [0.8, 0.9, 0.3, 0.7, 0.7, 0.6, 0.6, 0.2, 0.8, 0.5, 0.2, 0.7, 0.8] },
      { name: 'Kellman (D)',        party: 'D', dimIndices: [0,1,2,3,4,5,6,7,8,9,10,11,12], scores: [0.5, 0.6, 0.3, 0.9, 0.7, 0.8, 0.6, 0.2, 0.7, 0.3, 0.2, 0.8, 0.7] },
      { name: 'Romero (R)',         party: 'R', dimIndices: [0,1,2,3,4,5,6,7,8,9,10,11,12], scores: [0.5, 0.1, 0.7, 0.3, 0.2, 0.2, 0.2, 0.8, 0.1, 0.5, 0.7, 0.2, 0.3] },
      { name: 'Shelton (R)',        party: 'R', dimIndices: [0,1,2,3,4,5,6,7,8,9,10,11,12], scores: [0.5, 0.2, 0.7, 0.2, 0.3, 0.2, 0.2, 0.8, 0.1, 0.7, 0.6, 0.2, 0.3] },
      { name: 'Collenberg (R)',     party: 'R', dimIndices: [0,1,2,3,4,5,6,7,8,9,10,11,12], scores: [0.6, 0.2, 0.8, 0.2, 0.4, 0.2, 0.3, 0.8, 0.2, 0.6, 0.7, 0.2, 0.3] },
    ],
  },
  // ── Attorney General (subset) ──
  {
    name: 'Attorney General',
    candidates: [
      { name: 'Bonta (D-inc)', party: 'D', dimIndices: [2, 8, 7, 11, 6, 12], scores: [0.3, 0.8, 0.2, 0.8, 0.8, 0.7] },
      { name: 'Gates (R)',     party: 'R', dimIndices: [2, 8, 7, 11, 6, 12], scores: [0.9, 0.1, 0.8, 0.2, 0.1, 0.2] },
      { name: 'Mikels (G)',    party: 'G', dimIndices: [2, 8, 7, 11, 6, 12], scores: [0.1, 0.9, 0.1, 0.9, 0.9, 0.9] },
    ],
  },
  // ── Secretary of State (subset) ──
  {
    name: 'Secretary of State',
    candidates: [
      { name: 'Weber (D-inc)',  party: 'D', dimIndices: [7, 8, 10, 6, 12], scores: [0.2, 0.8, 0.2, 0.7, 0.6] },
      { name: 'Wagner (R)',     party: 'R', dimIndices: [7, 8, 10, 6, 12], scores: [0.7, 0.2, 0.9, 0.2, 0.3] },
      { name: 'Feinstein (G)',  party: 'G', dimIndices: [7, 8, 10, 6, 12], scores: [0.2, 0.8, 0.1, 0.7, 0.9] },
      { name: 'Blenner (G)',    party: 'G', dimIndices: [7, 8, 10, 6, 12], scores: [0.2, 0.8, 0.1, 0.7, 0.9] },
    ],
  },
  // ── Controller (subset) ──
  {
    name: 'Controller',
    candidates: [
      { name: 'Cohen (D-inc)', party: 'D',   dimIndices: [1, 7, 9, 8, 12], scores: [0.6, 0.3, 0.4, 0.7, 0.6] },
      { name: 'Morgan (R)',    party: 'R',   dimIndices: [1, 7, 9, 8, 12], scores: [0.2, 0.7, 0.8, 0.3, 0.3] },
      { name: 'Adams (P&F)',   party: 'P&F', dimIndices: [1, 7, 9, 8, 12], scores: [0.9, 0.1, 0.3, 0.9, 0.9] },
    ],
  },
  // ── Insurance Commissioner (subset) ──
  {
    name: 'Insurance Commissioner',
    candidates: [
      { name: 'Allen (D)',     party: 'D', dimIndices: [3, 5, 11, 7, 8, 12], scores: [0.6, 0.6, 0.7, 0.3, 0.7, 0.6] },
      { name: 'Kim (D)',       party: 'D', dimIndices: [3, 5, 11, 7, 8, 12], scores: [0.8, 0.8, 0.9, 0.2, 0.8, 0.8] },
      { name: 'Wolff (D)',     party: 'D', dimIndices: [3, 5, 11, 7, 8, 12], scores: [0.6, 0.7, 0.7, 0.3, 0.6, 0.6] },
      { name: 'Bradford (D)',  party: 'D', dimIndices: [3, 5, 11, 7, 8, 12], scores: [0.6, 0.7, 0.7, 0.3, 0.7, 0.6] },
      { name: 'Korsgaden (R)', party: 'R', dimIndices: [3, 5, 11, 7, 8, 12], scores: [0.2, 0.2, 0.3, 0.7, 0.2, 0.3] },
      { name: 'Farren (R)',    party: 'R', dimIndices: [3, 5, 11, 7, 8, 12], scores: [0.2, 0.2, 0.3, 0.7, 0.2, 0.3] },
    ],
  },
  // ── Treasurer (subset) ──
  {
    name: 'Treasurer',
    candidates: [
      { name: 'Caballero (D)',  party: 'D', dimIndices: [0, 1, 7, 9, 3, 8, 6, 12], scores: [0.8, 0.6, 0.3, 0.3, 0.5, 0.6, 0.7, 0.6] },
      { name: 'Kounalakis (D)', party: 'D', dimIndices: [0, 1, 7, 9, 3, 8, 6, 12], scores: [0.7, 0.6, 0.3, 0.3, 0.6, 0.7, 0.6, 0.6] },
      { name: 'Vazquez (D)',    party: 'D', dimIndices: [0, 1, 7, 9, 3, 8, 6, 12], scores: [0.9, 0.7, 0.3, 0.5, 0.6, 0.7, 0.7, 0.7] },
      { name: 'Hawks (R)',      party: 'R', dimIndices: [0, 1, 7, 9, 3, 8, 6, 12], scores: [0.2, 0.2, 0.7, 0.8, 0.1, 0.2, 0.3, 0.3] },
      { name: 'Serpa (R)',      party: 'R', dimIndices: [0, 1, 7, 9, 3, 8, 6, 12], scores: [0.8, 0.2, 0.8, 0.6, 0.3, 0.3, 0.3, 0.3] },
      { name: 'Turner (G)',     party: 'G', dimIndices: [0, 1, 7, 9, 3, 8, 6, 12], scores: [0.5, 0.9, 0.2, 0.2, 0.8, 0.8, 0.7, 0.9] },
    ],
  },
  // ── Superintendent of Public Instruction (NONPARTISAN) ──
  {
    name: 'Superintendent of Public Instruction',
    candidates: [
      { name: 'Barrera (NPP)',    party: 'NPP', dimIndices: [4, 7, 8, 1, 12], scores: [0.8, 0.2, 0.7, 0.7, 0.7] },
      { name: 'Muratsuchi (NPP)', party: 'NPP', dimIndices: [4, 7, 8, 1, 12], scores: [0.8, 0.3, 0.6, 0.6, 0.6] },
      { name: 'Rendon (NPP)',     party: 'NPP', dimIndices: [4, 7, 8, 1, 12], scores: [0.7, 0.3, 0.7, 0.6, 0.6] },
      { name: 'Newman (NPP)',     party: 'NPP', dimIndices: [4, 7, 8, 1, 12], scores: [0.7, 0.3, 0.6, 0.5, 0.6] },
      { name: 'Shaw (NPP)',       party: 'NPP', dimIndices: [4, 7, 8, 1, 12], scores: [0.5, 0.7, 0.1, 0.1, 0.3] },
    ],
  },
];

// ─── Scoring ──────────────────────────────────────────────────────────────

/**
 * Build the 13-dim user vector from a list of answers. Q0 (party) is read
 * separately via `extractPartyChoice` and not part of the dim vector.
 * Missing Likert answers default to 0.5 (neutral).
 */
export function buildUserProfile(answers: readonly CaSlateAnswer[]): number[] {
  // Index by questionId, then map Likert answers onto the 13-dim vector via
  // question axis. Importing questions.ts here would create a cycle with
  // session.ts → routes, so we replicate the axis lookup inline using
  // the questionId convention (d{1..13}_*).
  const byId = new Map<string, CaSlateAnswer>();
  for (const a of answers) byId.set(a.questionId, a);

  // Axis index 0..12 corresponds to DIM_NAMES order. The 13 Likert ids
  // are d1..d13 in axis order — see questions.ts.
  const idByAxis: readonly string[] = [
    'd1_housing',
    'd2_tax',
    'd3_crime',
    'd4_climate',
    'd5_education',
    'd6_healthcare',
    'd7_immigration',
    'd8_limited_gov',
    'd9_dei',
    'd10_fiscal',
    'd11_election',
    'd12_consumer',
    'd13_aipac',
  ];

  const profile: number[] = new Array(13).fill(0.5);
  for (let i = 0; i < 13; i++) {
    const ans = byId.get(idByAxis[i]);
    if (ans && ans.type === 'likert') {
      const score = LIKERT_SCORES[ans.position];
      if (score !== undefined) profile[i] = score;
    }
  }
  return profile;
}

/**
 * Read the Q0 party choice from an answers list. Defaults to 'any' if Q0 is
 * missing or malformed (so the snap still renders results for legacy
 * sessions that pre-date the filter).
 */
export function extractPartyChoice(answers: readonly CaSlateAnswer[]): PartyChoice {
  const q0 = answers.find((a) => a.questionId === 'q0_party');
  if (q0 && q0.type === 'party') return q0.choice;
  return 'any';
}

function normalizedEuclidean(
  userVec: readonly number[],
  dimIndices: readonly number[],
  candScores: readonly number[]
): number {
  let total = 0;
  for (let i = 0; i < dimIndices.length; i++) {
    const idx = dimIndices[i];
    const cs = candScores[i];
    if (idx === undefined || cs === undefined) continue;
    const diff = (userVec[idx] ?? 0.5) - cs;
    total += diff * diff;
  }
  const n = dimIndices.length;
  return n > 0 ? Math.sqrt(total / n) : Infinity;
}

/**
 * Score one office: filter candidate pool by party, then rank by Euclidean
 * distance on the office's relevant dims. Returns ranked list with
 * alignment = 1 - distance (clamped to [0, 1]).
 */
export function scoreOffice(
  office: Office,
  userVec: readonly number[],
  party: PartyChoice
): OfficeMatch {
  const allowed = PARTY_FILTER[party];
  const pool = office.candidates.filter((c) => allowed.has(c.party));

  const ranked = pool
    .map((c) => {
      const d = normalizedEuclidean(userVec, c.dimIndices, c.scores);
      return {
        name: c.name,
        party: c.party,
        distance: d,
        alignment: Math.max(0, Math.min(1, 1 - d)),
      };
    })
    .sort((a, b) => a.distance - b.distance);

  const top = ranked[0];
  return {
    name: office.name,
    topCandidate: top?.name ?? '— no candidates in pool —',
    topParty: top?.party ?? 'NPP',
    topAlignment: top?.alignment ?? 0,
    topDistance: top?.distance ?? Infinity,
    topReason: oneLineReason(office, userVec),
    allRanked: ranked,
  };
}

/**
 * Full result: 8 office matches, with the user's 13-dim profile included for
 * context. Used by both the snap result scene and the React result page.
 */
export interface CaSlateResult {
  userProfile: number[];          // 13-dim [0,1]
  partyChoice: PartyChoice;
  offices: OfficeMatch[];         // 8 offices, ranked
  totalAnswered: number;          // 13 Likert + 1 Q0
  totalExpected: number;          // CA_SLATE_LENGTH + 1
}

export function scoreCaSlate(answers: readonly CaSlateAnswer[]): CaSlateResult {
  const userProfile = buildUserProfile(answers);
  const partyChoice = extractPartyChoice(answers);
  const offices = OFFICES.map((o) => scoreOffice(o, userProfile, partyChoice));
  return {
    userProfile,
    partyChoice,
    offices,
    totalAnswered: answers.length,
    totalExpected: CA_SLATE_LENGTH + 1,
  };
}

// ─── One-line reason helper ───────────────────────────────────────────────
// Per skill's Type C transparency rule: result must include a 1-line reason
// for the match. We pick the dim with the smallest user↔candidate distance
// on this office's relevant subset and phrase it as a position match.

const AXIS_SHORT: Record<CaSlateAxis, string> = {
  housing: 'housing',
  tax: 'tax',
  crime: 'criminal justice',
  climate: 'climate',
  education: 'education',
  healthcare: 'healthcare',
  immigration: 'immigration',
  limitedGov: 'limited government',
  dei: 'DEI',
  fiscal: 'fiscal oversight',
  election: 'election integrity',
  consumer: 'consumer protection',
  aipac: 'AIPAC funding',
};

export function oneLineReason(office: Office, userVec: readonly number[]): string {
  // Find the user→candidate distance contribution per dim, then pick the
  // smallest one (closest match on a single axis). Build a short label.
  let bestDim: CaSlateAxis = 'housing';
  let bestContrib = Infinity;
  for (const c of office.candidates) {
    for (let i = 0; i < c.dimIndices.length; i++) {
      const idx = c.dimIndices[i];
      const cs = c.scores[i];
      if (idx === undefined || cs === undefined) continue;
      const axis = DIM_NAMES[idx];
      if (!axis) continue;
      const u = userVec[idx] ?? 0.5;
      const diff = Math.abs(u - cs);
      if (diff < bestContrib) {
        bestContrib = diff;
        bestDim = axis;
      }
    }
  }
  return `closest match on ${AXIS_SHORT[bestDim]}`;
}

// Unused but exported for symmetry with the bartlet/values pattern — keeps
// the public surface stable if a future LLM narrative generator wants to
// consume the same data shape.
export function _envPlaceholder(_e: Env): void { /* no-op */ }
