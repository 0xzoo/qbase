/**
 * Mapping between the server-side `QueryType` enum (`'mc' | 'checkbox' |
 * 'text' | 'scale' | 'scale_range'`) and the local UI-side type used by
 * `CreateQueryModal` and any other modal that distinguishes
 * `'multiple_choice'` from `'mc'`.
 *
 * Lives outside the modal so consumers (e.g. `QuestionSlide`'s fork
 * action) can call `apiTypeToLocal` without forcing the modal file to
 * export a non-component value — that breaks Vite's
 * `react-refresh/only-export-components` invariant.
 */
import type { QueryType as ApiQueryType } from './types';

/** UI-side query type the modal's form state works with. */
export type QueryType = 'text' | 'multiple_choice' | 'checkbox' | 'scale';

export function apiTypeToLocal(type: ApiQueryType): QueryType {
  switch (type) {
    case 'mc': return 'multiple_choice';
    case 'checkbox': return 'checkbox';
    case 'scale': return 'scale';
    case 'scale_range': return 'scale';
    default: return 'text';
  }
}
