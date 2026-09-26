/**
 * qbase handles: the name a person is known by on qbase, whatever they signed
 * in with. Stored in `Users.username` (lowercase, unique where set: migration
 * 0077), served at `/ask/:handle`.
 *
 * Accounts that came with a name keep it: Farcaster accounts use their fname,
 * Ethereum accounts their verified ENS name. Everyone else picks one. A new
 * pick is 3-20 of [a-z0-9_-] (no dots: a dotted name is an ENS or Farcaster
 * name the person proved, never typed), not reserved, not held by another
 * qbase account, and not a Farcaster username held by someone whose fid is
 * not linked to this account (so /ask/dwr cannot be claimed away from dwr).
 * The Farcaster check fails open when every provider is down: the data router
 * answers null on outage, and a missed collision is only as bad as the
 * username fallback it shadows.
 */

import { initFarcasterData } from '../farcaster';
import { farcasterFidOf } from './AccountService';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

export const HANDLE_PATTERN = /^[a-z0-9][a-z0-9_-]{1,18}[a-z0-9]$/;
/** What `/ask/:handle` and the by-handle lookup accept (backfilled names may carry dots). */
export const HANDLE_LOOKUP_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const RESERVED = new Set([
  'admin', 'system', 'api', 'support', 'qbase', 'askqbase', 'moderator', 'mod', 'root', 'staff', 'team', 'help',
  'null', 'undefined', 'constructor', '__proto__', 'prototype', 'localhost',
  'www', 'mail', 'ftp', 'smtp', 'imap', 'dns', 'ssl', 'tls',
  'me', 'you', 'anon', 'anonymous', '4n0n', 'polls', 'poll', 'qgent', 'q', 'council', 'qlaude', 'qemini', 'chatqpt',
  'settings', 'ask', 'question', 'questions', 'quiz', 'snap', 'stake', 'about', 'login', 'signin', 'signup', 'logout',
  'account', 'profile', 'official', 'security', 'farcaster', 'world', 'ens',
]);

export type HandleVerdict =
  | { ok: true; handle: string }
  | { ok: false; handle: string; code: 'invalid' | 'reserved' | 'taken' | 'farcaster_taken'; reason: string };

export function normalizeHandle(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().replace(/^@/, '').toLowerCase() : '';
}

/**
 * Whether `raw` can become `accountId`'s handle. Pure checks first, then the
 * qbase table, then Farcaster. Re-picking your current handle is fine.
 */
export async function checkHandle(env: Env, raw: unknown, accountId: number | null): Promise<HandleVerdict> {
  const handle = normalizeHandle(raw);
  if (!HANDLE_PATTERN.test(handle)) {
    return { ok: false, handle, code: 'invalid', reason: '3-20 characters: lowercase letters, numbers, - and _ (not at the ends)' };
  }
  if (RESERVED.has(handle)) return { ok: false, handle, code: 'reserved', reason: 'This handle is reserved' };

  const holder = await env.DB.prepare('SELECT fid FROM Users WHERE username = ?').bind(handle).first() as { fid: number } | null;
  if (holder && Number(holder.fid) !== accountId) return { ok: false, handle, code: 'taken', reason: 'Handle already taken' };

  try {
    const fcUser = await initFarcasterData(env).getUserByUsername(handle);
    if (fcUser?.fid) {
      const ownFid = accountId === null ? undefined : await farcasterFidOf(env, accountId);
      if (Number(fcUser.fid) !== ownFid) {
        return { ok: false, handle, code: 'farcaster_taken', reason: 'Someone on Farcaster has this name' };
      }
    }
  } catch (err) {
    console.warn('[handles] Farcaster username check failed, allowing:', err);
  }
  return { ok: true, handle };
}

/**
 * Set `accountId`'s handle after checkHandle passed. The unique index is the
 * real guard: a concurrent claim of the same name loses here with 'taken'.
 */
export async function setHandle(env: Env, accountId: number, handle: string): Promise<'ok' | 'taken' | 'no_profile'> {
  try {
    const r = await env.DB.prepare('UPDATE Users SET username = ? WHERE fid = ?').bind(handle, accountId).run();
    return (r.meta?.changes ?? 0) > 0 ? 'ok' : 'no_profile';
  } catch (err) {
    if (String((err as Error)?.message ?? err).includes('UNIQUE')) return 'taken';
    throw err;
  }
}

/**
 * Best effort: give a profile row that has no handle yet the name it came
 * with (a Farcaster fname, a verified ENS name), when nobody holds it. Never
 * throws — profile creation must not fail on the unique index; a row left
 * without a handle is asked to pick one.
 */
export async function seedHandle(env: Env, key: number, candidate: string | null | undefined): Promise<void> {
  const handle = normalizeHandle(candidate);
  if (!HANDLE_LOOKUP_PATTERN.test(handle) || RESERVED.has(handle)) return;
  try {
    await env.DB.prepare(
      `UPDATE Users SET username = ? WHERE fid = ? AND (username IS NULL OR username = '')
         AND NOT EXISTS (SELECT 1 FROM Users WHERE username = ?)`,
    ).bind(handle, key, handle).run();
  } catch (err) {
    console.warn('[handles] seed failed:', err);
  }
}
