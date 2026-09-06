// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Env = any;

export interface AnswerRequest {
  q_id: string;
  user_id: number; // Injected by worker from auth token
  value: string;   // Plain display text of the answer
  answer_type_id: number; // FK to answer_types: 1=text, 2=mc, 3=scale, 4=checkbox
  answer_data?: Record<string, unknown>; // Type-specific structured data
  audience: 'Public' | 'Private' | 'Anon' | 'Allowlist';
  /** Wave this answer is cast through. Omit for a direct answer to the question. */
  poll_id?: string;
  allowlist_id?: string; // Reference to named allowlist
  allowlist?: number[]; // One-off FID array
  // Knowledge-question fields (optional)
  reasoning?: string; // Justification for knowledge answers
  topics?: string[]; // Domain tags for knowledge answers
}
