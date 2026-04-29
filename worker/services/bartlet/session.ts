// bartlet — session state in KV.
//
// Stored at BARTLET_SESSIONS[sid] with 30-day TTL. One session per quiz
// attempt, bound to an FID on first POST (intro → q0). Subsequent POSTs with
// a mismatched JFS FID are rejected.
//
// Answers are stored separately in QStorage; the KV blob only keeps ephemeral
// state (index, airdrop status, etc.). This prevents KV value size limits from
// being exceeded by long answer arrays.

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

// QStorage key for answers
function answersKey(sid: string): string {
  return `bartlet/answers/${sid}`;
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
  // Save session to KV WITHOUT answers (answers live in QStorage)
  // KV first — it's always available and the quiz needs it to progress.
  const sessionForKv = { ...s, answers: [] };
  await kv(env).put(key(s.id), JSON.stringify(sessionForKv), {
    expirationTtl: SESSION_TTL_SECONDS,
  });

  // Save answers to QStorage (best-effort — quiz works without it)
  try {
    const { QStorageService } = await import('../QStorageService');
    const qstorage = QStorageService.fromEnv(env);
    await qstorage.put(
      answersKey(s.id),
      JSON.stringify(s.answers),
      { 'session-id': s.id, 'fid': String(s.fid) },
      'application/json'
    );
  } catch (err) {
    console.warn('[bartlet] QStorage save failed (answers not persisted):', err);
  }
}

export async function loadSession(
  env: Env,
  sid: string
): Promise<BartletSession | null> {
  const raw = await kv(env).get(key(sid));
  if (!raw) return null;

  let session: BartletSession;
  try {
    session = JSON.parse(raw) as BartletSession;
  } catch {
    return null;
  }

  // Load answers from QStorage
  try {
    const { QStorageService } = await import('../QStorageService');
    const qstorage = QStorageService.fromEnv(env);
    const answersData = await qstorage.get(answersKey(sid));
    if (answersData && answersData.data) {
      const answersJson = new TextDecoder().decode(answersData.data);
      session.answers = JSON.parse(answersJson) as BartletAnswer[];
    } else {
      // Backward compat: if QStorage has no answers but session has index > 0,
      // the session still loads with empty answers. This is acceptable for old sessions.
      session.answers = [];
    }
  } catch (err) {
    // If QStorage fails, continue with empty answers (graceful degradation)
    console.error(`[BartletSession] Failed to load answers from QStorage for ${sid}:`, err);
    session.answers = [];
  }

  return session;
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
