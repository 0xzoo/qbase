/**
 * quizAudience — types, labels, copy and pure helpers behind
 * QuizAudienceChooser (kept out of the component file so fast refresh sees
 * only components there). docs/specs/quiz-answer-audience.md §4.1, §4.4.
 */

export type QuizAudience = 'Private' | 'Anon' | 'Public';
export const QUIZ_AUDIENCES: QuizAudience[] = ['Private', 'Anon', 'Public'];

export interface QuizAnswerItem {
  id: string;
  q_id: string;
  stem: string;
  kind: 'mc' | 'scale' | 'text';
  audience: string;
  value: string | null;
  label: string | null;
  error?: string;
}

/** One completion as GET /api/me/quiz-answers returns it. */
export interface QuizCompletionView {
  id: string;
  quiz_id: string;
  completed_at: number;
  result_category: string | null;
  materialized: boolean;
  counts: Record<string, number>;
  items: QuizAnswerItem[];
}

/** What a result page gets from its session endpoint. */
export interface CompletionRef {
  id: string;
  materialized: boolean;
}

export interface RescopeFailure {
  id: string;
  code: 'audience_sticky' | 'unopenable' | 'not_yours' | 'error';
  error: string;
  existing?: 'Public' | 'Anon';
}

export interface RescopeResponse {
  changed: number;
  unchanged: number;
  failed: RescopeFailure[];
  items: Array<{ id: string; audience: string }>;
  error?: string;
}

export const QUIZ_TITLES: Record<string, string> = {
  bartlet: 'bartlet',
  values: 'values',
  apperception: 'app·erception',
};

export const AUDIENCE_LABEL: Record<QuizAudience, string> = {
  Private: 'Secret',
  Anon: 'Anon',
  Public: 'Public',
};

export const AUDIENCE_HINT: Record<QuizAudience, string> = {
  Private: 'Secret: only you and q can read these. They still count in your report and in aggregate stats, never with your name.',
  Anon: 'Anon: each answer counts in the public tally of its question, with no name attached.',
  Public: 'Public: each answer appears on the question with your name.',
};

export const MIXED_HINT = 'Mixed: some answers are placed differently. Pick one to apply it to the whole quiz.';

export function isQuizAudience(a: string): a is QuizAudience {
  return a === 'Private' || a === 'Anon' || a === 'Public';
}

export function countsOf(items: QuizAnswerItem[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const it of items) counts[it.audience] = (counts[it.audience] ?? 0) + 1;
  return counts;
}

/** The audience every row carries, or null when they differ (or there are none). */
export function dominantAudience(c: QuizCompletionView): QuizAudience | null {
  const entries = Object.entries(c.counts);
  if (entries.length !== 1) return null;
  const [only] = entries[0];
  return isQuizAudience(only) ? only : null;
}

/** Why an item stayed where it was, in the person's terms. */
export function reasonText(f: RescopeFailure): string {
  if (f.code === 'audience_sticky') {
    const how = f.existing === 'Anon' ? 'anonymously' : 'publicly';
    const match = f.existing === 'Anon' ? 'Anon' : 'Public';
    return `You already answered this question ${how}. This answer can be Secret, or ${match} to match.`;
  }
  if (f.code === 'unopenable') return 'Could not open this answer.';
  return f.error || 'Could not change this answer.';
}

export function outcomeText(body: RescopeResponse, audience: QuizAudience): string {
  const label = AUDIENCE_LABEL[audience];
  const kept = body.failed.length;
  if (body.changed === 0 && kept === 0) return `Already ${label}.`;
  const changed = body.changed === 1 ? '1 answer' : `${body.changed} answers`;
  return kept
    ? `${changed} now ${label}, ${kept} kept — see below.`
    : `${changed} now ${label}.`;
}

export function formatCompletionDate(ms: number): string {
  try {
    return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}
