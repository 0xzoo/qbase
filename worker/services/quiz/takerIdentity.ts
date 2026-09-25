/**
 * Who took a quiz, in the two senses the account-root migration separates
 * (docs/specs/account-root.md §5, §6.1):
 *
 *  - `fid`: the taker's Farcaster fid. The quiz session blobs (KV + sealed
 *    answers) are keyed and sealed by it for their short life, and it drives
 *    every Farcaster operation (Neynar gate, verified addresses for airdrops).
 *    0 for a web taker signed in with an account that has no Farcaster fid
 *    (possible only after the cutover).
 *  - the person key (`userKey`): what durable rows carry (quiz_completions,
 *    Answers, quiz_airdrops, bartlet_unlocks). Before the cutover it is the
 *    fid; after, the account id.
 *
 * A session stores `userKey` only when it has no fid. A Farcaster session
 * resolves its person key when the durable row is written, never at creation:
 * a session begun before the cutover and finished after must write the
 * account id, not the fid it started with.
 */

import { isAccountId, userKeyForFid } from '../accounts/AccountService';
import type { AuthResult } from '../../middleware/auth';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

export interface QuizTaker {
  /** Farcaster fid, or 0 when the account has none. */
  fid: number;
  /** Person key (fid before the cutover, account id after). */
  userKey: number;
}

export interface TakerSession {
  fid: number;
  userKey?: number;
}

/**
 * The taker behind an authenticated web request, or null (→ 401). A caller
 * without a fid is accepted only when it has an account id, so before the
 * cutover this admits exactly the callers the routes admitted before
 * (`auth.fid` required).
 */
export function webTaker(auth: AuthResult): QuizTaker | null {
  if (!auth.authenticated) return null;
  if (auth.fid) return { fid: auth.fid, userKey: auth.userKey ?? auth.fid };
  if (isAccountId(auth.userKey)) return { fid: 0, userKey: auth.userKey };
  return null;
}

/** The person key for a session's durable rows. */
export async function sessionUserKey(env: Env, s: TakerSession): Promise<number> {
  if (s.fid) return userKeyForFid(env, s.fid);
  if (s.userKey !== undefined) return s.userKey;
  throw new Error('quiz session has neither a fid nor a user key');
}

/** Does this session belong to this taker? Farcaster sessions compare fids, as before. */
export function ownsSession(s: TakerSession, taker: QuizTaker): boolean {
  if (s.fid) return s.fid === taker.fid;
  return s.userKey !== undefined && s.userKey === taker.userKey;
}

/** The session-index KV key for a taker: `fid:<fid>` (unchanged), else `acct:<userKey>`. */
export function takerIndexKey(t: TakerSession): string {
  if (t.fid) return `fid:${t.fid}`;
  if (t.userKey === undefined) throw new Error('quiz taker has neither a fid nor a user key');
  return `acct:${t.userKey}`;
}

/** Owner bound into the sealed session answers: the fid (unchanged), else the account id. */
export function sessionSealOwner(s: TakerSession): number {
  return s.fid || (s.userKey ?? 0);
}
