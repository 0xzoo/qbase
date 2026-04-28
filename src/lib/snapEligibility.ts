/**
 * Determines whether a question will render as an inline snap in Farcaster clients,
 * vs falling back to the "Answer on qbase" miniapp button.
 *
 * Rules (mirrors SnapService.ts rendering logic):
 * - mc: eligible if ≤5 options (otherwise falls back to miniapp)
 * - text: always eligible
 * - scale: always eligible
 * - scale_range: never eligible
 * - checkbox: eligible if 1–6 options
 * - everything else: not eligible
 */
import type { Query } from './types';

export function isSnapRenderable(question: Pick<Query, 'type' | 'a_options'>): boolean {
  switch (question.type) {
    case 'mc':
      return (question.a_options?.length ?? 0) <= 5;
    case 'text':
    case 'scale':
      return true;
    case 'checkbox':
      return (question.a_options?.length ?? 0) >= 1 && (question.a_options?.length ?? 0) <= 6;
    default:
      return false;
  }
}
