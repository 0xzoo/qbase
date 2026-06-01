// ca-slate — California Full Slate Quiz questions.
//
// One Q0 party affiliation filter + 13 policy Likert stems. Each Likert maps
// 1:1 to a policy dimension; per-office scoring uses only the dimensions
// relevant to that office (see scoring.ts).
//
// Source: specs/quizzes/ca-slate/SPEC.md. Question stems written 2026-05-30;
// validated against 8 voter personas (63/64 slots at top-3). Q0 party filter
// added 2026-06-01 — improves top-3 coverage to 80/80 (10 personas).
//
// Voice: policy-stance register. Direct, lowercase. "the state should…"
// "california should…" For Type C political quizzes the transparency is the
// point — the user knows they're answering policy questions and the positions
// help them self-locate. (See references/ca-full-slate-quiz-spec.md.)

export type CaSlateAxis =
  | 'housing'
  | 'tax'
  | 'crime'
  | 'climate'
  | 'education'
  | 'healthcare'
  | 'immigration'
  | 'limitedGov'
  | 'dei'
  | 'fiscal'
  | 'election'
  | 'consumer'
  | 'aipac';

export type PartyChoice = 'dem' | 'rep' | 'any';

export interface CaSlateLikert {
  id: string;
  stem: string;
  type: 'likert';
  axis: CaSlateAxis;
}

export interface CaSlateParty {
  id: 'q0_party';
  type: 'party';
  stem: string;
  options: ReadonlyArray<{ label: string; choice: PartyChoice }>;
}

export type CaSlateQuestion = CaSlateLikert | CaSlateParty;

// ─── Q0: party affiliation pre-filter ──────────────────────────────────────
// Mandatory for political Type C. Filter applies to partisan offices only;
// nonpartisan offices (Superintendent) always show all NPP candidates.
//
// Mapping in scoring.ts:
//   dem → D + G + P&F + NPP (Dem primary + small left + nonpartisan)
//   rep → R + NPP (Rep primary; Greens surface only if no better R match exists)
//   any → all candidates

export const PARTY_QUESTION: CaSlateParty = {
  id: 'q0_party',
  type: 'party',
  stem: 'which primary will you vote in?',
  options: [
    { label: 'democratic primary', choice: 'dem' },
    { label: 'republican primary', choice: 'rep' },
    { label: 'any party / nonpartisan only', choice: 'any' },
  ],
};

// ─── 13 policy dimensions ──────────────────────────────────────────────────
// "i believe…" / "the state should…" register. Both poles equally respectable
// on every stem — no "correct" answer implied. Convention: higher agreement
// = higher dimension score (e.g. agree with "tax the wealthy" → D2 = 0.75+).
//
// AIPAC D13 polarity (fix from 2026-05-30): agree with the stem = anti-AIPAC.
// Candidates with no public AIPAC record scored 0.5 (neutral).

export const caSlateQuestions: readonly CaSlateLikert[] = [
  {
    id: 'd1_housing',
    axis: 'housing',
    type: 'likert',
    stem: 'the state should override local zoning laws to build more housing, even when communities object',
  },
  {
    id: 'd2_tax',
    axis: 'tax',
    type: 'likert',
    stem: 'the wealthiest californians and corporations should pay more to fund public services',
  },
  {
    id: 'd3_crime',
    axis: 'crime',
    type: 'likert',
    stem: "california's criminal justice reforms have gone too far — we need stricter sentencing and enforcement",
  },
  {
    id: 'd4_climate',
    axis: 'climate',
    type: 'likert',
    stem: 'california should lead on aggressive climate action, even if it raises costs for consumers',
  },
  {
    id: 'd5_education',
    axis: 'education',
    type: 'likert',
    stem: 'education funding should be a higher priority than it is now',
  },
  {
    id: 'd6_healthcare',
    axis: 'healthcare',
    type: 'likert',
    stem: 'california should move toward a single-payer healthcare system, even if it requires major tax increases',
  },
  {
    id: 'd7_immigration',
    axis: 'immigration',
    type: 'likert',
    stem: 'california should continue as a sanctuary state and resist cooperating with federal immigration enforcement',
  },
  {
    id: 'd8_limited_gov',
    axis: 'limitedGov',
    type: 'likert',
    stem: 'i want lower taxes, fewer regulations, and more local control in california',
  },
  {
    id: 'd9_dei',
    axis: 'dei',
    type: 'likert',
    stem: "california's progressive policies on DEI, gender, and equity make the state better",
  },
  {
    id: 'd10_fiscal',
    axis: 'fiscal',
    type: 'likert',
    stem: 'state spending needs more independent auditing and less blind trust in government programs',
  },
  {
    id: 'd11_election',
    axis: 'election',
    type: 'likert',
    stem: 'voter id and other election integrity measures would restore confidence in california elections',
  },
  {
    id: 'd12_consumer',
    axis: 'consumer',
    type: 'likert',
    stem: 'the state should regulate industries more aggressively to protect consumers, even if it raises prices',
  },
  {
    id: 'd13_aipac',
    axis: 'aipac',
    type: 'likert',
    stem: 'i would be less likely to vote for a candidate who takes money from aipac or other pro-israel lobbying groups',
  },
];

// Question order for the snap: Q0 first (party), then 13 dims in a fixed
// order. Order chosen to mix dim types (tax ↔ crime ↔ climate) so adjacent
// questions don't prime each other.
export const CA_SLATE_LENGTH = caSlateQuestions.length; // 13
export const CA_SLATE_TOTAL = CA_SLATE_LENGTH + 1;       // 14 with Q0

// Axis index by question.id — used to map a user's Likert answer at index i
// to the right dimension slot in their 13-dim profile vector.
export function axisIndex(axis: CaSlateAxis): number {
  return caSlateQuestions.findIndex((q) => q.type === 'likert' && q.axis === axis);
}

// Map a question id → its axis index in the dim vector (0..12). Returns -1
// for Q0 (which doesn't map to any axis).
export function dimIndexForQuestion(questionId: string): number {
  if (questionId === 'q0_party') return -1;
  const q = caSlateQuestions.find((qq) => qq.id === questionId);
  if (!q || q.type !== 'likert') return -1;
  return axisIndex(q.axis);
}
