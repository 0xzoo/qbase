/**
 * canonicalAnswers — one quiz item answer → the shape of one Answers row.
 *
 * Each bespoke quiz keeps its answers in its own shape: bartlet
 * `{queryId, optionIndex}`, values and apperception `{questionId, type, …}`.
 * The canonical question for every item already exists in `queries` under the
 * item's slug (admin-register-*-queries), so the only translation is into the
 * value / answer_data / answer_type_id conventions every other answer uses
 * (AGENTS.md "Answer storage routing"):
 *
 *   mc     (2)  value = the option label,   answer_data = { index }
 *   scale  (3)  value = raw numeric text,   answer_data = { index: numeric }
 *   text   (1)  value = the text,           answer_data = null
 *
 * A Likert position 0..4 lands on the registered 5-point scale (min 1, max 5)
 * as 1..5. The question bank decides the item's type; the answer's own `type`
 * field is not trusted. Unknown quizzes, unknown items and malformed answers
 * return null and the caller counts them as skipped.
 */

import { bartletQuestions } from '../bartlet/questions';
import { valuesQuestions } from '../values/questions';
import { apperceptionQuestions } from '../apperception/questions';

export const ANSWER_TYPE_TEXT = 1;
export const ANSWER_TYPE_MC = 2;
export const ANSWER_TYPE_SCALE = 3;

export interface CanonicalAnswer {
  qId: string;
  answerTypeId: 1 | 2 | 3;
  value: string;
  answerData: Record<string, unknown> | null;
}

/** Quizzes whose completions materialise into Answers rows. */
export const MATERIALIZED_QUIZZES = ['bartlet', 'values', 'apperception'] as const;
export type MaterializedQuiz = (typeof MATERIALIZED_QUIZZES)[number];

export function isMaterializedQuiz(quizId: string): quizId is MaterializedQuiz {
  return (MATERIALIZED_QUIZZES as readonly string[]).includes(quizId);
}

const bartletById = new Map(bartletQuestions.map((q) => [q.id, q]));
const valuesById = new Map(valuesQuestions.map((q) => [q.id, q]));
const apperceptionById = new Map(apperceptionQuestions.map((q) => [q.id, q]));

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function asInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) ? v : null;
}

function mc(qId: string, labels: readonly { label: string }[], optionIndex: unknown): CanonicalAnswer | null {
  const idx = asInt(optionIndex);
  if (idx === null || idx < 0 || idx >= labels.length) return null;
  return { qId, answerTypeId: ANSWER_TYPE_MC, value: labels[idx].label, answerData: { index: idx } };
}

/** Likert position 0..4 → scale value 1..5 (the registered scale_config is min 1, max 5). */
function likert(qId: string, position: unknown): CanonicalAnswer | null {
  const pos = asInt(position);
  if (pos === null || pos < 0 || pos > 4) return null;
  const n = pos + 1;
  return { qId, answerTypeId: ANSWER_TYPE_SCALE, value: String(n), answerData: { index: n } };
}

function text(qId: string, value: unknown): CanonicalAnswer | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  return { qId, answerTypeId: ANSWER_TYPE_TEXT, value, answerData: null };
}

export function toCanonicalAnswer(quizId: string, answer: unknown): CanonicalAnswer | null {
  const a = asRecord(answer);
  if (!a) return null;

  switch (quizId) {
    case 'bartlet': {
      const q = typeof a.queryId === 'string' ? bartletById.get(a.queryId) : undefined;
      return q ? mc(q.id, q.a_options, a.optionIndex) : null;
    }
    case 'values': {
      const q = typeof a.questionId === 'string' ? valuesById.get(a.questionId) : undefined;
      if (!q) return null;
      if (q.type === 'likert') return likert(q.id, a.position);
      if (q.type === 'forced') return mc(q.id, q.a_options, a.optionIndex);
      return text(q.id, a.text);
    }
    case 'apperception': {
      const q = typeof a.questionId === 'string' ? apperceptionById.get(a.questionId) : undefined;
      if (!q) return null;
      if (q.type === 'likert') return likert(q.id, a.position);
      return mc(q.id, q.a_options, a.optionIndex);
    }
    default:
      return null;
  }
}
