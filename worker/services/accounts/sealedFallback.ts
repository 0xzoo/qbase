/**
 * Sealed reads across the account cutover (docs/specs/account-root.md §5).
 *
 * Secret envelopes bind their owner into the AAD. Between the `rewrite` phase
 * (rows now name an account id) and the `reowner` sweep (envelopes re-sealed
 * under it), an envelope still names the legacy key. A reader that hits a
 * context mismatch for an account id retries once under that account's legacy
 * key. Remove once `status` reports no legacy envelopes.
 */

import { SecretContextMismatchError } from '../secret/SecretBox';
import { legacyKeyOf } from '../AnonAttributionService';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

export async function openWithOwnerFallback<T>(env: Env, owner: number, open: (owner: number) => Promise<T>): Promise<T> {
  try {
    return await open(owner);
  } catch (e) {
    if (!(e instanceof SecretContextMismatchError)) throw e;
    const legacy = await legacyKeyOf(env, owner);
    if (legacy === null) throw e;
    return open(legacy);
  }
}
