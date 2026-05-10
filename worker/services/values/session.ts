// values — session state in KV.
//
// Stored at VALUES_SESSIONS[sid] with 30-day TTL. One session per quiz
// attempt, bound to an FID on first POST (intro → q0). Subsequent POSTs with
// a mismatched JFS FID are rejected.
//
// Answers are stored separately in QStorage (secret by default) — the KV
// blob only keeps ephemeral session state. Mirrors the bartlet pattern at
// `worker/services/bartlet/session.ts`.
//
// Unlike bartlet, values has no airdrop and no one-time unlock payment.
// The gated result tier is checked at render time against live $QQ balance,
// so there's no `paid` flag in session state.

import type { ValuesAnswer } from './scoring';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

export interface ValuesSession {
  id: string;
  fid: number;
  answers: ValuesAnswer[];
  // number of answers recorded; next question is at this index
  index: number;
  createdAt: number;
}

function kv(env: Env): KVNamespace {
  const ns = env.VALUES_SESSIONS;
  if (!ns) throw new Error('VALUES_SESSIONS KV namespace not bound');
  return ns;
}

function key(sid: string): string {
  return `session:${sid}`;
}

function answersKey(sid: string): string {
  return `values/answers/${sid}`;
}

// Index from fid → most recently completed sid, so revisits can skip the
// quiz and re-render the result. Written only when index reaches the bank
// length.
function fidIndexKey(fid: number): string {
  return `fid:${fid}`;
}

const FID_INDEX_TTL_SECONDS = 60 * 60 * 24 * 90; // 90 days

export function newSessionId(): string {
  return crypto.randomUUID();
}

export function newSession(id: string, fid: number): ValuesSession {
  return { id, fid, answers: [], index: 0, createdAt: Date.now() };
}

export async function saveSession(env: Env, s: ValuesSession): Promise<void> {
  // KV first (always available, drives quiz progression). Strip answers
  // before storing — they live in QStorage to avoid KV value size limits
  // on long open-text responses.
  const sessionForKv = { ...s, answers: [] };
  await kv(env).put(key(s.id), JSON.stringify(sessionForKv), {
    expirationTtl: SESSION_TTL_SECONDS,
  });

  // QStorage answers (best-effort — quiz still works without it).
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
    console.warn('[values] QStorage save failed (answers not persisted):', err);
  }
}

export async function loadSession(
  env: Env,
  sid: string
): Promise<ValuesSession | null> {
  const raw = await kv(env).get(key(sid));
  if (!raw) return null;

  let session: ValuesSession;
  try {
    session = JSON.parse(raw) as ValuesSession;
  } catch {
    return null;
  }

  try {
    const { QStorageService } = await import('../QStorageService');
    const qstorage = QStorageService.fromEnv(env);
    const answersData = await qstorage.get(answersKey(sid));
    if (answersData && answersData.data) {
      const answersJson = new TextDecoder().decode(answersData.data);
      session.answers = JSON.parse(answersJson) as ValuesAnswer[];
    } else {
      session.answers = [];
    }
  } catch (err) {
    console.error(`[ValuesSession] Failed to load answers from QStorage for ${sid}:`, err);
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
): Promise<ValuesSession | null> {
  const sid = await kv(env).get(fidIndexKey(fid));
  if (!sid) return null;
  return loadSession(env, sid);
}
