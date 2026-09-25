/**
 * EligibilityService — runtime check for whether a viewer is allowed to
 * answer through a poll (wave). Two gates can apply, both on the wave:
 *
 *   1. closes_at: voting locks past this timestamp (results stay visible).
 *      NOT NULL on `polls` — the time gate is what makes a wave a wave.
 *   2. eligibility_gate: JSON config restricting *who* can vote —
 *      `nft_snapshot` or `token_snapshot`, both resolved to an inline
 *      `snapshot_fids` allowlist at wave creation; or `world_id`, where each
 *      first answer carries a World ID proof (WorldIdService) and nothing is
 *      resolved up front.
 *
 * Gates live on waves only. A question is never gated: a direct answer
 * (`Answers.poll_id = NULL`) never reaches this service. Callers that hold a
 * poll id use `check` / `checkById`; surfaces that only know the question
 * (the snap URL until Track A4, `/api/queries/:id/eligibility`) resolve the
 * question's current wave via `checkQuestion`.
 *
 * Anonymity does not bypass the gate: callers pass the viewer's real FID,
 * then store the answer anon. On `closed` / `not_holder` the caller decides
 * the HTTP shape (423 Locked / 403 Forbidden respectively). `not_verified`
 * means "answer through the World ID route" (POST /api/polls/:id/world-answer).
 */

import type { EligibilityGate } from '../../src/lib/types';
import { getCurrentPoll, getPoll, type PollRow } from './PollService';
import { anonTag, anonTagReady, ownRowsSql } from './anon/AnonTag';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

export type EligibilityReason = 'no_gate' | 'open' | 'closed' | 'not_holder' | 'not_verified' | 'unknown_gate';

export interface EligibilityResult {
  eligible: boolean;
  reason: EligibilityReason;
  /** When time-gated, the close timestamp the caller can surface */
  closesAt?: string;
  /** The wave the result applies to (absent when a question has no wave). */
  pollId?: string;
}

/**
 * Shape we accept for eligibility checks: a `polls` row, or any object
 * carrying the two gate fields (pre-parsed or raw D1 strings). `id` keys the
 * per-FID KV cache; without it the snapshot lookup is uncached.
 */
export interface EligibilityCheckable {
  id?: string;
  question_id?: string;
  closes_at?: string | null;
  eligibility_gate?: EligibilityGate | string | null;
}

/**
 * What a `world_id` gate may rely on besides the gate itself. Both default
 * off, so a public probe (`?fid=`) never learns whether an account answered.
 */
export interface EligibilityContext {
  /** This request carries a World ID proof for this wave, verified and claimed. */
  worldVerified?: boolean;
  /**
   * The caller is authenticated as `fid`: an answer the account already has
   * in this wave (only writable with a proof) lets it re-answer without one.
   */
  answeringAsSelf?: boolean;
}

/**
 * Cache result of a successful per-FID lookup against an immutable snapshot.
 * Snapshots never change once stored, so the only invalidation is wave
 * deletion — 1h TTL keeps the KV warm without unbounded growth.
 */
const ELIGIBILITY_CACHE_TTL_S = 60 * 60;

export class EligibilityService {
  /**
   * Check whether `fid` is allowed to answer through `poll` right now.
   *
   * Order of checks:
   *   1. closes_at past → `closed`
   *   2. no eligibility_gate → `no_gate`
   *   3. snapshot gate: fid in snapshot_fids? → `open` else `not_holder`
   *   4. world_id gate: proof in this request, or (as self) a prior answer in
   *      this wave → `open`, else `not_verified`
   */
  static async check(
    env: Env,
    poll: EligibilityCheckable,
    fid: number,
    ctx: EligibilityContext = {},
  ): Promise<EligibilityResult> {
    const pollId = poll.id;
    const closesAt = poll.closes_at ?? undefined;

    if (poll.closes_at) {
      const closesMs = Date.parse(poll.closes_at);
      if (Number.isFinite(closesMs) && closesMs <= Date.now()) {
        return { eligible: false, reason: 'closed', closesAt, pollId };
      }
    }

    const gate = parseGate(poll.eligibility_gate);
    if (!gate) {
      return { eligible: true, reason: 'no_gate', closesAt, pollId };
    }

    if (gate.type === 'world_id') {
      const verified = ctx.worldVerified
        || (ctx.answeringAsSelf && await hasAnswerInWave(env, poll, fid));
      return verified
        ? { eligible: true, reason: 'open', closesAt, pollId }
        : { eligible: false, reason: 'not_verified', closesAt, pollId };
    }

    if (gate.type !== 'nft_snapshot' && gate.type !== 'token_snapshot') {
      // Defensive: future gate types should be wired here. Both current
      // variants resolve to a `snapshot_fids` allowlist at creation, so
      // the membership check below is identical.
      return { eligible: false, reason: 'unknown_gate', closesAt, pollId };
    }

    if (pollId) {
      const cached = await readCache(env, pollId, fid);
      if (cached !== null) {
        return cached
          ? { eligible: true, reason: 'open', closesAt, pollId }
          : { eligible: false, reason: 'not_holder', closesAt, pollId };
      }
    }

    const eligible = Array.isArray(gate.snapshot_fids) && gate.snapshot_fids.includes(fid);

    if (pollId) {
      // Best-effort cache write; ignore failures.
      writeCache(env, pollId, fid, eligible).catch(() => undefined);
    }

    return eligible
      ? { eligible: true, reason: 'open', closesAt, pollId }
      : { eligible: false, reason: 'not_holder', closesAt, pollId };
  }

  /** Load a wave by id and run the check. `null` when the wave doesn't exist. */
  static async checkById(
    env: Env,
    pollId: string,
    fid: number,
  ): Promise<EligibilityResult | null> {
    const poll = await getPoll(env.DB, pollId);
    if (!poll) return null;
    return this.check(env, poll, fid);
  }

  /**
   * Resolve a question's current wave and run the check against it. A
   * question with no wave is always answerable (`no_gate`, no `pollId`).
   * `null` when the question doesn't exist.
   */
  static async checkQuestion(
    env: Env,
    questionId: string,
    fid: number,
  ): Promise<(EligibilityResult & { poll: PollRow | null }) | null> {
    const exists = await env.DB.prepare('SELECT id FROM queries WHERE id = ? LIMIT 1')
      .bind(questionId)
      .first();
    if (!exists) return null;
    const poll = await getCurrentPoll(env.DB, questionId);
    if (!poll) return { eligible: true, reason: 'no_gate', poll: null };
    const result = await this.check(env, poll, fid);
    return { ...result, poll };
  }
}

/**
 * Does `fid` already own an answer in this wave (any audience; Anon rows via
 * the author tag)? On a world_id wave that row was written with a proof, so
 * the account may change its answer without spending the nullifier again.
 */
async function hasAnswerInWave(env: Env, poll: EligibilityCheckable, fid: number): Promise<boolean> {
  if (!poll.id || !poll.question_id) return false;
  const tag = (await anonTagReady(env)) ? await anonTag(env, fid, poll.question_id) : null;
  const row = await env.DB.prepare(
    `SELECT 1 FROM Answers a WHERE a.q_id = ? AND a.poll_id = ? AND ${ownRowsSql('a')} LIMIT 1`,
  ).bind(poll.question_id, poll.id, fid, tag ?? '').first();
  return !!row;
}

function parseGate(
  raw: EligibilityCheckable['eligibility_gate'],
): EligibilityGate | null {
  if (!raw) return null;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as EligibilityGate;
    } catch {
      console.error('[EligibilityService] failed to parse eligibility_gate JSON');
      return null;
    }
  }
  return raw;
}

export function eligibilityCacheKey(pollId: string, fid: number): string {
  return `poll:eligible:${pollId}:${fid}`;
}

async function readCache(env: Env, pollId: string, fid: number): Promise<boolean | null> {
  try {
    const raw = await env.KV_USER_PROFILES.get(eligibilityCacheKey(pollId, fid));
    if (raw === '1') return true;
    if (raw === '0') return false;
    return null;
  } catch {
    return null;
  }
}

async function writeCache(
  env: Env,
  pollId: string,
  fid: number,
  eligible: boolean,
): Promise<void> {
  await env.KV_USER_PROFILES.put(
    eligibilityCacheKey(pollId, fid),
    eligible ? '1' : '0',
    { expirationTtl: ELIGIBILITY_CACHE_TTL_S },
  );
}
