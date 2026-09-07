// apperception — session state in KV.
//
// Stored at APPERCEPTION_SESSIONS[sid] with 30-day TTL. One session per quiz
// attempt, bound to an FID on first POST. Subsequent POSTs with a mismatched
// FID (from JFS) are rejected.
//
// Answers are stored in QStorage, sealed to Q (SecretStore). KV blob holds ephemeral
// session state only. Mirrors values' session.ts.

import type { ApperceptionAnswer } from './scoring';
import type { DimNarratives } from './dimNarrativeGenerator';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

export interface ApperceptionSession {
  id: string;
  fid: number;
  answers: ApperceptionAnswer[];
  index: number;
  // LLM-generated per-dim {summary, blindSpot} pairs. Set on first
  // /api/apperception/dim-narratives call where the $QQ gate is open.
  // null = call attempted but failed; undefined = not yet attempted.
  dimNarratives?: DimNarratives | null;
  // Prompt/model version that generated the cached narratives. When this
  // is older than the current DIM_NARRATIVES_VERSION the entry is treated
  // as stale and regenerated on next unlocked load.
  dimNarrativesVersion?: number;
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
  // Sealed under a key Q holds before it leaves the Worker (SecretStore).
  // Best-effort on a storage failure; when no key is configured the write is
  // skipped and logged — answers are never written as plaintext.
  try {
    const { putJSON } = await import('../secret/SecretStore');
    await putJSON(env, answersKey(s.id), s.answers, {
      tier: 'session',
      owner: s.fid,
      meta: { 'session-id': s.id, 'fid': String(s.fid) },
    });
  } catch (err) {
    console.warn('[apperception] sealed answers save failed (answers not persisted):', err);
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

  // Opened through SecretStore (the only decrypt path); legacy plaintext
  // blobs are re-sealed on read during the migration window.
  try {
    const { getJSON } = await import('../secret/SecretStore');
    const answers = await getJSON<ApperceptionAnswer[]>(env, answersKey(sid), { tier: 'session', owner: session.fid });
    // A session with no blob (old, or the save was skipped) loads with empty answers.
    session.answers = answers ?? [];
  } catch (err) {
    console.error('[apperception] failed to load sealed answers for ' + sid + ':', err);
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
