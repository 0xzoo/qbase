/**
 * itemMeta — display metadata for a canonical quiz item, from the question
 * banks rather than D1: stem, kind, and a human label for a stored value.
 *
 * Scale values are the registered 1..5 Likert points; the label comes from the
 * bank's anchor list (identical for values and apperception). MC values are
 * already the option label; text is itself.
 */

import { bartletQuestions } from '../bartlet/questions';
import { valuesQuestions, LIKERT_LABELS } from '../values/questions';
import { apperceptionQuestions } from '../apperception/questions';

export type ItemKind = 'mc' | 'scale' | 'text';

export interface ItemMeta {
  quiz: string;
  qId: string;
  stem: string;
  kind: ItemKind;
  /** option labels for mc items */
  options?: string[];
}

const META = new Map<string, ItemMeta>();
for (const q of bartletQuestions) {
  META.set(q.id, { quiz: 'bartlet', qId: q.id, stem: q.stem, kind: 'mc', options: q.a_options.map((o) => o.label) });
}
for (const q of valuesQuestions) {
  META.set(q.id, q.type === 'likert'
    ? { quiz: 'values', qId: q.id, stem: q.stem, kind: 'scale' }
    : q.type === 'forced'
      ? { quiz: 'values', qId: q.id, stem: q.stem, kind: 'mc', options: q.a_options.map((o) => o.label) }
      : { quiz: 'values', qId: q.id, stem: q.stem, kind: 'text' });
}
for (const q of apperceptionQuestions) {
  META.set(q.id, q.type === 'likert'
    ? { quiz: 'apperception', qId: q.id, stem: q.stem, kind: 'scale' }
    : { quiz: 'apperception', qId: q.id, stem: q.stem, kind: 'mc', options: q.a_options.map((o) => o.label) });
}

export function itemMeta(qId: string): ItemMeta | null {
  return META.get(qId) ?? null;
}

/** Human label for a stored canonical value. */
export function valueLabel(meta: ItemMeta, value: string): string {
  if (meta.kind === 'scale') {
    const n = Number(value);
    return Number.isInteger(n) && n >= 1 && n <= LIKERT_LABELS.length ? LIKERT_LABELS[n - 1] : value;
  }
  return value;
}

export const QUIZ_TITLES: Record<string, string> = {
  bartlet: 'bartlet',
  values: 'values',
  apperception: 'app·erception',
};
