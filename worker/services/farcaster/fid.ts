/**
 * FID parsing at the provider boundary.
 *
 * Since the Hypersnap validator fork (2026-11-13) the network has native
 * accounts whose FIDs start at 2^32, and the node emits those as decimal
 * strings in JSON ("fid":"4294967296"); legacy FIDs still arrive as numbers,
 * and some endpoints have switched between the two across releases.
 *
 * qbase keeps a FID as a JS number. The person-key space is split at 2^40
 * (accounts/migrationSql.ts): below it a value is a FID, from it up an account
 * id. Native FIDs count up from 2^32, so they fit; a "FID" at or above 2^40
 * would be read as an account id everywhere else, and is refused here.
 *
 * Every FID that enters the worker from a node, a JFS header or a webhook goes
 * through `parseFid`. Never compare or key on a wire FID directly.
 */

import { ACCOUNT_ID_MIN } from '../accounts/migrationSql';

/** First FID the network assigns to a natively registered account. */
export const NATIVE_FID_MIN = 4_294_967_296; // 2^32

/** A number or decimal string that is a valid FID → the number; anything else → null. */
export function parseFid(value: unknown): number | null {
  let n: number;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && /^[1-9][0-9]{0,15}$/.test(value)) n = Number(value);
  else return null;
  return Number.isSafeInteger(n) && n > 0 && n < ACCOUNT_ID_MIN ? n : null;
}

/** True for an account registered on Hypersnap itself (no OP id-registry entry, not relayed to Snapchain). */
export function isNativeFid(fid: number): boolean {
  return fid >= NATIVE_FID_MIN && fid < ACCOUNT_ID_MIN;
}
