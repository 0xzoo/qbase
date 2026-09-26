/**
 * Window events for the handle prompt (src/components/HandlePrompt.tsx).
 *
 * The prompt asks an account without a handle to pick one after its first
 * contribution (an answer or a question saved), not before: nobody has to
 * name themselves to look around. Anything can also open it on purpose (the
 * header's Profile item, Settings).
 */

export const CONTRIBUTED_EVENT = 'qbase:contributed';
export const PICK_HANDLE_EVENT = 'qbase:pick-handle';

export interface PickHandleDetail {
  /** Go to the new profile page once the handle is saved. */
  goToProfile?: boolean;
}

/** An answer or a question was just saved by the signed-in account. */
export function notifyContributed(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(CONTRIBUTED_EVENT));
}

export function openHandlePicker(detail: PickHandleDetail = {}): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent<PickHandleDetail>(PICK_HANDLE_EVENT, { detail }));
}

/** A starting suggestion from a name the account already shows (fname, ENS, display name). */
export function suggestHandle(...names: (string | null | undefined)[]): string {
  for (const name of names) {
    if (!name) continue;
    const base = name.toLowerCase().replace(/\.eth$/, '').replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, 20).replace(/[-_]+$/, '');
    if (base.length >= 3) return base;
  }
  return '';
}
