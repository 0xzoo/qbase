// bartlet — session state in KV.
//
// Stored at BARTLET_SESSIONS[sid] with 30-day TTL. One session per quiz
// attempt, bound to an FID on first POST (intro → q0). Subsequent POSTs with
// a mismatched JFS FID are rejected.

import type { BartletAnswer } from './scoring';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

export interface BartletSession {
  id: string;
  fid: number;
  answers: BartletAnswer[];
  index: number; // number of answers recorded; next question is at this index
  airdropped: boolean;
  airdropTxHash?: string;
  airdropStatus?: string; // serialized AirdropOutcome.kind for re-render
  airdropAmountTokens?: string;
  paid: boolean;
  createdAt: number;
}

function kv(env: Env): KVNamespace {
  const ns = env.BARTLET_SESSIONS;
  if (!ns) throw new Error('BARTLET_SESSIONS KV namespace not bound');
  return ns;
}

function key(sid: string): string {
  return `session:${sid}`;
}

// Index from fid → most recently completed sid, so revisits can skip the
// quiz and re-render the result. Written only when a session reaches
// BARTLET_LENGTH answers. Slightly longer TTL than the session itself.
function fidIndexKey(fid: number): string {
  return `fid:${fid}`;
}

const FID_INDEX_TTL_SECONDS = 60 * 60 * 24 * 90; // 90 days

export function newSessionId(): string {
  return crypto.randomUUID();
}

export function newSession(id: string, fid: number): BartletSession {
  return {
    id,
    fid,
    answers: [],
    index: 0,
    airdropped: false,
    paid: false,
    createdAt: Date.now(),
  };
}

export async function saveSession(env: Env, s: BartletSession): Promise<void> {
  await kv(env).put(key(s.id), JSON.stringify(s), {
    expirationTtl: SESSION_TTL_SECONDS,
  });
}

export async function loadSession(
  env: Env,
  sid: string
): Promise<BartletSession | null> {
  const raw = await kv(env).get(key(sid));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as BartletSession;
  } catch {
    return null;
  }
}

export async function saveFidIndex(env: Env, fid: number, sid: string): Promise<void> {
  await kv(env).put(fidIndexKey(fid), sid, { expirationTtl: FID_INDEX_TTL_SECONDS });
}

export async function loadSessionForFid(
  env: Env,
  fid: number
): Promise<BartletSession | null> {
  const sid = await kv(env).get(fidIndexKey(fid));
  if (!sid) return null;
  return loadSession(env, sid);
}
