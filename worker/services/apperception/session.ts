// apperception — session state in KV.
//
// Stored at APPERCEPTION_SESSIONS[sid] with 30-day TTL. One session per quiz
// attempt, bound to an FID on first POST. Subsequent POSTs with a mismatched
// FID (from JFS) are rejected.
//
// Answers are stored in QStorage (secret by default). KV blob holds ephemeral
// session state only. Mirrors values' session.ts.

import type { ApperceptionAnswer } from './scoring';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

export interface ApperceptionSession {
  id: string;
  fid: number;
  answers: ApperceptionAnswer[];
  index: number;
  // Airdrop state
  airdropped: boolean;
  airdropTxHash?: string;
  airdropStatus?: string;
  airdropAmountTokens?: string;
  // User rating — stored on session so it only prompts once
  rated: boolean;
  createdAt: number;
}

function kv(env: Env): KVNamespace {
  const ns = env.APPERCEPTION_SESSIONS;
  if (!ns) throw new Error('APPERCEPTION_SESSIONS KV namespace not bound');
  return ns;
}

function sessionKey(sid: string): string {
  return `session:${sid}`;
}

function answersKey(sid: string): string {
  return `apperception/answers/${sid}`;
}

function fidIndexKey(fid: number): string {
  return `fid:${fid}`;
}

const FID_INDEX_TTL_SECONDS = 60 * 60 * 24 * 90; // 90 days

export function newSessionId(): string {
  return crypto.randomUUID();
}

export function newSession(id: string, fid: number): ApperceptionSession {
  return {
    id,
    fid,
    answers: [],
    index: 0,
    airdropped: false,
    rated: false,
    createdAt: Date.now(),
  };
}

export async function saveSession(env: Env, s: ApperceptionSession): Promise<void> {
  // KV — strip answers to avoid size limits
  const sessionForKv = { ...s, answers: undefined };
  await kv(env).put(sessionKey(s.id), JSON.stringify(sessionForKv), {
    expirationTtl: SESSION_TTL_SECONDS,
  });

  // QStorage answers (best-effort)
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
    console.warn('[apperception] QStorage save failed (answers not persisted):', err);
  }
}

export async function loadSession(
  env: Env,
  sid: string
): Promise<ApperceptionSession | null> {
  const raw = await kv(env).get(sessionKey(sid));
  if (!raw) return null;

  let session: ApperceptionSession;
  try {
    session = JSON.parse(raw) as ApperceptionSession;
  } catch {
    return null;
  }

  try {
    const { QStorageService } = await import('../QStorageService');
    const qstorage = QStorageService.fromEnv(env);
    const answersData = await qstorage.get(answersKey(sid));
    if (answersData && answersData.data) {
      const answersJson = new TextDecoder().decode(answersData.data);
      session.answers = JSON.parse(answersJson) as ApperceptionAnswer[];
    } else {
      session.answers = [];
    }
  } catch (err) {
    console.error(`[Apperception] Failed to load answers from QStorage for ${sid}:`, err);
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
): Promise<ApperceptionSession | null> {
  const sid = await kv(env).get(fidIndexKey(fid));
  if (!sid) return null;
  return loadSession(env, sid);
}
