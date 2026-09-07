// bartlet — session state in KV.
//
// Stored at BARTLET_SESSIONS[sid] with 30-day TTL. One session per quiz
// attempt, bound to an FID on first POST (intro → q0). Subsequent POSTs with
// a mismatched JFS FID are rejected.
//
// Answers are stored separately in QStorage, sealed to Q (SecretStore); the KV blob only keeps ephemeral
// state (index, airdrop status, etc.). This prevents KV value size limits from
// being exceeded by long answer arrays.

import type { BartletAnswer } from './scoring';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

export interface BartletSession {
  id: string;
  fid: number;
  // quiz_completions.id written at completion, so the result page can offer
  // the audience chooser for exactly this completion (absent on older blobs;
  // the session endpoint then falls back to the taker's latest completion).
  completionId?: string;
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
    console.warn('[bartlet] sealed answers save failed (answers not persisted):', err);
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
  // Opened through SecretStore (the only decrypt path); legacy plaintext
  // blobs are re-sealed on read during the migration window.
  try {
    const { getJSON } = await import('../secret/SecretStore');
    const answers = await getJSON<BartletAnswer[]>(env, answersKey(sid), { tier: 'session', owner: session.fid });
    // A session with no blob (old, or the save was skipped) loads with empty answers.
    session.answers = answers ?? [];
  } catch (err) {
    console.error('[bartlet] failed to load sealed answers for ' + sid + ':', err);
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
