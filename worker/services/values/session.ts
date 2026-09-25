// values — session state in KV.
//
// Stored at VALUES_SESSIONS[sid] with 30-day TTL. One session per quiz
// attempt, bound to an FID on first POST (intro → q0). Subsequent POSTs with
// a mismatched JFS FID are rejected.
//
// Answers are stored separately in QStorage, sealed to Q (SecretStore) — the KV
// blob only keeps ephemeral session state. Mirrors the bartlet pattern at
// `worker/services/bartlet/session.ts`.
//
// Like bartlet, values airdrops 4.42M $QQ on completion (Neynar-gated, with
// a 1000-slot cohort cap). The gated result-tier export is checked
// separately at render time against live $QQ balance, so there's no `paid`
// flag in session state — only the airdrop status is cached.

import type { ValuesAnswer, ValuesScore } from './scoring';
import type { DimNarratives } from './dimNarrativeGenerator';
import { sessionSealOwner, takerIndexKey, type TakerSession } from '../quiz/takerIdentity';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

export interface ValuesSession {
  id: string;
  // Farcaster fid of the taker; 0 for a web taker whose account has no fid
  // (services/quiz/takerIdentity.ts).
  fid: number;
  // Person key, set only when fid is 0 (a Farcaster session resolves its
  // person key at write time).
  userKey?: number;
  // quiz_completions.id written at completion, so the result page can offer
  // the audience chooser for exactly this completion (absent on older blobs;
  // the session endpoint then falls back to the taker's latest completion).
  completionId?: string;
  answers: ValuesAnswer[];
  // number of answers recorded; next question is at this index
  index: number;
  // LLM-derived per-dim scores from the open-text reflections, set once
  // the classifier runs (typically at completion). null = call attempted
  // but no scorable answers / failure; undefined = not yet attempted.
  openTextScores?: Omit<ValuesScore, 'confidence'> | null;
  // LLM-generated per-dim {summary, blindSpot} pairs. Set on first
  // /api/values/session call where the $QQ gate is open. null = call
  // attempted but failed; undefined = not yet attempted (or still locked).
  dimNarratives?: DimNarratives | null;
  // Prompt/model version that generated the cached narratives. When this
  // is older than the current DIM_NARRATIVES_VERSION the entry is treated
  // as stale and regenerated on next unlocked load.
  dimNarrativesVersion?: number;
  // Airdrop pipeline state. `airdropped` flips true on success or
  // already_claimed; `airdropStatus` carries the AirdropOutcome.kind so
  // re-renders can rebuild the result snap's badge without re-running the
  // pipeline.
  airdropped: boolean;
  airdropTxHash?: string;
  airdropStatus?: string;
  airdropAmountTokens?: string;
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

export function newSession(id: string, fid: number, userKey?: number): ValuesSession {
  return {
    id,
    fid,
    ...(!fid && userKey !== undefined ? { userKey } : {}),
    answers: [],
    index: 0,
    airdropped: false,
    createdAt: Date.now(),
  };
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
  // Sealed under a key Q holds before it leaves the Worker (SecretStore).
  // Best-effort on a storage failure; when no key is configured the write is
  // skipped and logged — answers are never written as plaintext.
  try {
    const { putJSON } = await import('../secret/SecretStore');
    await putJSON(env, answersKey(s.id), s.answers, {
      tier: 'session',
      owner: sessionSealOwner(s),
      meta: { 'session-id': s.id, 'fid': String(s.fid) },
    });
  } catch (err) {
    console.warn('[values] sealed answers save failed (answers not persisted):', err);
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

  // Opened through SecretStore (the only decrypt path); legacy plaintext
  // blobs are re-sealed on read during the migration window.
  try {
    const { getJSON } = await import('../secret/SecretStore');
    const answers = await getJSON<ValuesAnswer[]>(env, answersKey(sid), { tier: 'session', owner: sessionSealOwner(session) });
    // A session with no blob (old, or the save was skipped) loads with empty answers.
    session.answers = answers ?? [];
  } catch (err) {
    console.error('[values] failed to load sealed answers for ' + sid + ':', err);
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

/**
 * Index a finished session under its taker: the fid index (unchanged) for a
 * Farcaster session, `acct:<userKey>` for a taker with no fid.
 */
export async function saveSessionIndex(env: Env, s: ValuesSession): Promise<void> {
  await kv(env).put(takerIndexKey(s), s.id, { expirationTtl: FID_INDEX_TTL_SECONDS });
}

/** The indexed session for a taker (fid index, or the account index when fid is 0). */
export async function loadSessionForTaker(env: Env, t: TakerSession): Promise<ValuesSession | null> {
  const sid = await kv(env).get(takerIndexKey(t));
  if (!sid) return null;
  return loadSession(env, sid);
}
