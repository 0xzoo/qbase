// values — compatibility plumbing: load two sealed values completions from
// D1, compare them (compare.ts), name the two people through the Farcaster
// data router, and cache the LLM narrative in KV.
//
// The completion id is the capability. It is a random UUID that only the
// owner ever sees (GET /api/me/quiz-answers, /api/quiz-completions?user_id=me),
// so a compare URL carrying it is a link the owner chose to hand out — the
// same consent model as the values result sid, but durable: sessions expire
// from KV after 30 days, completions do not.

import { readCompletionAnswers, type CompletionRow } from '../../routes/quiz-completions';
import { initFarcasterData } from '../farcaster/FarcasterDataRouter';
import { farcasterFidOf } from '../accounts/AccountService';
import type { FarcasterUser } from '../farcaster/FarcasterDataProvider';
import {
  COMPARE_VERSION,
  COMPARE_DIMS,
  compareProfiles,
  generateCompareNarrative,
  staticNarrative,
  type CompareNames,
  type CompareNarrative,
  type CompareProfile,
  type Comparison,
} from './compare';
import { valuesQuestions, type ValuesAxis } from './questions';
import { scoreValues, type ValuesAnswer, type ValuesScore } from './scoring';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
export function isCompletionId(s: string): boolean {
  return UUID_RE.test(s);
}

export interface PersonCard {
  completionId: string;
  /** Farcaster fid, 0 when the account has none. Never the person key. */
  fid: number;
  username: string | null;
  displayName: string | null;
  pfpUrl: string | null;
  dominant: ValuesAxis;
  secondary: ValuesAxis;
  scores: ValuesScore;
  completedAt: number;
}

export interface CompareResponse {
  status: 'ok';
  version: number;
  a: PersonCard;
  b: PersonCard;
  /** Which side the signed-in viewer is, if either. */
  viewer: 'a' | 'b' | null;
  comparison: Comparison;
  narrative: CompareNarrative;
  narrativeSource: 'llm' | 'static';
  narrativeError?: string;
}

export interface LatestCompletion {
  id: string;
  completedAt: number;
  dominant: ValuesAxis | null;
}

const KNOWN_QUESTIONS = new Set(valuesQuestions.map((q) => q.id));

/** Keep only well-formed values answers against known items. */
export function sanitizeAnswers(raw: unknown): ValuesAnswer[] {
  if (!Array.isArray(raw)) return [];
  const out: ValuesAnswer[] = [];
  for (const x of raw) {
    if (!x || typeof x !== 'object') continue;
    const r = x as Record<string, unknown>;
    if (typeof r.questionId !== 'string' || !KNOWN_QUESTIONS.has(r.questionId)) continue;
    if (r.type === 'likert' && typeof r.position === 'number' && Number.isInteger(r.position)) {
      out.push({ questionId: r.questionId, type: 'likert', position: r.position });
    } else if (r.type === 'forced' && (r.optionIndex === 0 || r.optionIndex === 1)) {
      out.push({ questionId: r.questionId, type: 'forced', optionIndex: r.optionIndex });
    } else if (r.type === 'open' && typeof r.text === 'string') {
      out.push({ questionId: r.questionId, type: 'open', text: r.text });
    }
  }
  return out;
}

function isAxis(v: unknown): v is ValuesAxis {
  return typeof v === 'string' && (COMPARE_DIMS as readonly string[]).includes(v);
}

function rankDims(scores: ValuesScore): ValuesAxis[] {
  return [...COMPARE_DIMS].sort((x, y) => scores[y] - scores[x]);
}

/**
 * The stored `scores` JSON (`{...five dims, confidence, dominant, secondary}`)
 * is the blended figure the person saw on their result page; use it when
 * it is whole, else re-score from the answers (Likert + forced only).
 */
function profileScores(rawScores: unknown, answers: ValuesAnswer[]): {
  scores: ValuesScore; dominant: ValuesAxis; secondary: ValuesAxis;
} {
  let parsed: Record<string, unknown> | null = null;
  if (typeof rawScores === 'string' && rawScores) {
    try { parsed = JSON.parse(rawScores) as Record<string, unknown>; } catch { parsed = null; }
  } else if (rawScores && typeof rawScores === 'object') {
    parsed = rawScores as Record<string, unknown>;
  }
  const whole = parsed && COMPARE_DIMS.every((d) => typeof parsed![d] === 'number' && Number.isFinite(parsed![d] as number));
  const scores: ValuesScore = whole
    ? {
        autonomy: parsed!.autonomy as number,
        care: parsed!.care as number,
        openness: parsed!.openness as number,
        mastery: parsed!.mastery as number,
        universalism: parsed!.universalism as number,
        confidence: typeof parsed!.confidence === 'number' ? (parsed!.confidence as number) : 1,
      }
    : scoreValues(answers);
  const ranked = rankDims(scores);
  const dominant = whole && isAxis(parsed!.dominant) ? parsed!.dominant : ranked[0];
  const secondary = whole && isAxis(parsed!.secondary) && parsed!.secondary !== dominant
    ? parsed!.secondary
    : ranked.find((d) => d !== dominant) ?? ranked[1];
  return { scores, dominant, secondary };
}

/** A values completion by id, answers opened through the sanctioned path. Null when absent. */
export async function loadValuesProfile(env: Env, completionId: string): Promise<CompareProfile | null> {
  const row = (await env.DB.prepare(
    "SELECT id, quiz_id, user_id, completed_at, visibility, answers_encrypted, answers_snapshot, scores FROM quiz_completions WHERE id = ? AND quiz_id = 'values'",
  ).bind(completionId).first()) as (CompletionRow & { completed_at: number; scores: string | null }) | null;
  if (!row) return null;

  let answers: ValuesAnswer[] = [];
  try {
    answers = sanitizeAnswers(await readCompletionAnswers(env, row));
  } catch (e) {
    console.error(`[values compare] could not open answers for ${completionId}:`, e);
  }
  const { scores, dominant, secondary } = profileScores(row.scores, answers);
  // user_id is the person key; the Farcaster fid (for names) comes from the account.
  const userKey = Number(row.user_id);
  return {
    completionId: row.id,
    fid: (await farcasterFidOf(env, userKey)) ?? 0,
    userKey,
    completedAt: Number(row.completed_at),
    scores,
    dominant,
    secondary,
    answers,
  };
}

/** The person's (`userKey`: person key) most recent values completion, or null. */
export async function latestValuesCompletion(env: Env, userKey: number): Promise<LatestCompletion | null> {
  const row = (await env.DB.prepare(
    "SELECT id, completed_at, result_category FROM quiz_completions WHERE quiz_id = 'values' AND user_id = ? ORDER BY completed_at DESC LIMIT 1",
  ).bind(userKey).first()) as { id: string; completed_at: number; result_category: string | null } | null;
  if (!row) return null;
  return {
    id: row.id,
    completedAt: Number(row.completed_at),
    dominant: isAxis(row.result_category) ? row.result_category : null,
  };
}

export type ResolveUsers = (fids: number[]) => Promise<Pick<FarcasterUser, 'fid' | 'username' | 'display_name' | 'pfp_url'>[]>;

async function defaultResolveUsers(env: Env, fids: number[]): Promise<FarcasterUser[]> {
  try {
    return await initFarcasterData(env).getUsers(fids);
  } catch (e) {
    console.warn('[values compare] user lookup failed:', e instanceof Error ? e.message : e);
    return [];
  }
}

export function personCard(profile: CompareProfile, user?: Pick<FarcasterUser, 'username' | 'display_name' | 'pfp_url'>): PersonCard {
  return {
    completionId: profile.completionId,
    fid: profile.fid,
    username: user?.username ?? null,
    displayName: user?.display_name ?? null,
    pfpUrl: user?.pfp_url ?? null,
    dominant: profile.dominant,
    secondary: profile.secondary,
    scores: profile.scores,
    completedAt: profile.completedAt,
  };
}

/** How a person is named in prose: @username, else their fid. */
export function proseName(card: Pick<PersonCard, 'username' | 'fid'>): string {
  if (card.username) return `@${card.username}`;
  return card.fid ? `fid ${card.fid}` : 'someone';
}

/** The person key that owns a values completion, or null. */
export async function completionUserKey(env: Env, completionId: string): Promise<number | null> {
  const row = (await env.DB.prepare(
    "SELECT user_id FROM quiz_completions WHERE id = ? AND quiz_id = 'values'",
  ).bind(completionId).first()) as { user_id: number } | null;
  return row ? Number(row.user_id) : null;
}

const profileKey = (p: CompareProfile): number => p.userKey ?? p.fid;

export interface CompareOptions {
  /** The signed-in viewer's person key (compared against quiz_completions.user_id). */
  viewerKey?: number;
  /** @deprecated alias of viewerKey (before the cutover the two are equal). */
  viewerFid?: number;
  resolveUsers?: ResolveUsers;
  generate?: (env: Env, cmp: Comparison, names: CompareNames) => Promise<{ narrative: CompareNarrative | null; error?: string }>;
}

const NARRATIVE_TTL_SECONDS = 60 * 60 * 24 * 30; // an LLM narrative, 30 days
const FALLBACK_TTL_SECONDS = 60 * 60;            // a failed call, retried after an hour

interface CachedNarrative {
  narrative: CompareNarrative;
  source: 'llm' | 'static';
  error?: string;
}

function narrativeKey(idA: string, idB: string): string {
  return `compare:v${COMPARE_VERSION}:${idA}:${idB}`;
}

async function cachedNarrative(env: Env, key: string): Promise<CachedNarrative | null> {
  const kv = env.VALUES_SESSIONS as KVNamespace | undefined;
  if (!kv) return null;
  try {
    const raw = await kv.get(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedNarrative;
    return parsed && parsed.narrative ? parsed : null;
  } catch {
    return null;
  }
}

async function storeNarrative(env: Env, key: string, value: CachedNarrative): Promise<void> {
  const kv = env.VALUES_SESSIONS as KVNamespace | undefined;
  if (!kv) return;
  try {
    await kv.put(key, JSON.stringify(value), {
      expirationTtl: value.source === 'llm' ? NARRATIVE_TTL_SECONDS : FALLBACK_TTL_SECONDS,
    });
  } catch (e) {
    console.warn('[values compare] narrative cache write failed:', e instanceof Error ? e.message : e);
  }
}

/**
 * Compare two values completions. Null when either id is not a values
 * completion. The narrative is generated once per (a, b, version) and cached.
 */
export async function compareCompletions(
  env: Env,
  idA: string,
  idB: string,
  opts: CompareOptions = {},
): Promise<CompareResponse | null> {
  const [pa, pb] = await Promise.all([loadValuesProfile(env, idA), loadValuesProfile(env, idB)]);
  if (!pa || !pb) return null;

  const resolve: ResolveUsers = opts.resolveUsers ?? ((fids) => defaultResolveUsers(env, fids));
  const fids = [...new Set([pa.fid, pb.fid].filter((f) => f > 0))];
  const users = fids.length ? await resolve(fids) : [];
  const byFid = new Map(users.map((u) => [u.fid, u]));
  const a = personCard(pa, pa.fid ? byFid.get(pa.fid) : undefined);
  const b = personCard(pb, pb.fid ? byFid.get(pb.fid) : undefined);

  const comparison = compareProfiles(pa, pb);
  const names: CompareNames = { a: proseName(a), b: proseName(b) };

  const key = narrativeKey(idA, idB);
  let cached = await cachedNarrative(env, key);
  if (!cached) {
    const generate = opts.generate ?? generateCompareNarrative;
    const { narrative, error } = await generate(env, comparison, names);
    cached = narrative
      ? { narrative, source: 'llm' }
      : { narrative: staticNarrative(comparison, names), source: 'static', error };
    await storeNarrative(env, key, cached);
  }

  const viewerKey = opts.viewerKey ?? opts.viewerFid;
  const viewer = viewerKey === undefined
    ? null
    : viewerKey === profileKey(pa) ? 'a'
    : viewerKey === profileKey(pb) ? 'b'
    : null;

  return {
    status: 'ok',
    version: COMPARE_VERSION,
    a,
    b,
    viewer,
    comparison,
    narrative: cached.narrative,
    narrativeSource: cached.source,
    ...(cached.error ? { narrativeError: cached.error } : {}),
  };
}

/** A person card for one completion (the "@alice wants to compare" teaser). */
export async function cardForCompletion(env: Env, id: string, resolveUsers?: ResolveUsers): Promise<PersonCard | null> {
  const p = await loadValuesProfile(env, id);
  if (!p) return null;
  const resolve: ResolveUsers = resolveUsers ?? ((fids) => defaultResolveUsers(env, fids));
  const users = p.fid ? await resolve([p.fid]) : [];
  return personCard(p, users[0]);
}
