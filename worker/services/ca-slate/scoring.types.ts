// ca-slate — answer + question types shared across the service module.
//
// Split out so session.ts / routes can import the answer type without
// pulling in the entire scoring.ts (which contains the candidate tables).

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

export interface CaSlateLikertAnswer {
  questionId: string;
  type: 'likert';
  position: number; // 0..4
}
export interface CaSlatePartyAnswer {
  questionId: 'q0_party';
  type: 'party';
  choice: PartyChoice;
}
export type CaSlateAnswer = CaSlateLikertAnswer | CaSlatePartyAnswer;

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
