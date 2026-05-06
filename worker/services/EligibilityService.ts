/**
 * EligibilityService — runtime check for whether a viewer is allowed to
 * answer a poll. Two gates can apply:
 *
 *   1. closes_at: voting locks past this timestamp (results stay visible).
 *   2. eligibility_gate: JSON config restricting *who* can vote. v0 only
 *      supports `nft_snapshot`, where the resolved FID list is stored
 *      inline on the gate (see NftHolderSnapshotService for resolution).
 *
 * Legacy (non-poll) questions have both fields NULL and short-circuit to
 * `no_gate` — i.e. fully open.
 *
 * Caller responsibility: load the query first (we accept either a parsed
 * Query-shaped object or the raw D1 row with stringified JSON columns).
 * On `closed` / `not_holder` the caller decides the HTTP shape (we recommend
 * 423 Locked / 403 Forbidden respectively).
 */

import type { EligibilityGate, Query } from '../../src/lib/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

export type EligibilityReason = 'no_gate' | 'open' | 'closed' | 'not_holder' | 'unknown_gate';

export interface EligibilityResult {
  eligible: boolean;
  reason: EligibilityReason;
  /** When eligible-but-time-gated, the close timestamp the caller can surface */
  closesAt?: string;
}

/**
 * Shape we accept for eligibility checks. The two fields can be either
 * pre-parsed (frontend Query shape) or raw strings from D1.
 */
export interface EligibilityCheckable {
  closes_at?: string | null;
  eligibility_gate?: EligibilityGate | string | null;
}

/**
 * Cache result of a successful per-FID lookup against an immutable snapshot.
 * Snapshots never change once stored, so the only invalidation is poll
 * deletion — 1h TTL keeps the KV warm without unbounded growth.
 */
const ELIGIBILITY_CACHE_TTL_S = 60 * 60;

export class EligibilityService {
  /**
   * Check whether `fid` is allowed to answer `query` right now.
   *
   * Order of checks:
   *   1. closes_at past → `closed`
   *   2. no eligibility_gate → `no_gate` (legacy-safe path)
   *   3. nft_snapshot: fid in snapshot_fids? → `open` else `not_holder`
   */
  static async check(
    env: Env,
    query: EligibilityCheckable,
    fid: number,
    queryId?: string,
  ): Promise<EligibilityResult> {
    if (query.closes_at) {
      const closesMs = Date.parse(query.closes_at);
      if (Number.isFinite(closesMs) && closesMs <= Date.now()) {
        return { eligible: false, reason: 'closed', closesAt: query.closes_at };
      }
    }

    const gate = parseGate(query.eligibility_gate);
    if (!gate) {
      return { eligible: true, reason: 'no_gate', closesAt: query.closes_at ?? undefined };
    }

    if (gate.type !== 'nft_snapshot' && gate.type !== 'token_snapshot') {
      // Defensive: future gate types should be wired here. Both current
      // variants resolve to a `snapshot_fids` allowlist at creation, so
      // the membership check below is identical.
      return { eligible: false, reason: 'unknown_gate' };
    }

    if (queryId) {
      const cached = await readCache(env, queryId, fid);
      if (cached !== null) {
        return cached
          ? { eligible: true, reason: 'open', closesAt: query.closes_at ?? undefined }
          : { eligible: false, reason: 'not_holder' };
      }
    }

    const eligible = gate.snapshot_fids.includes(fid);

    if (queryId) {
      // Best-effort cache write; ignore failures.
      writeCache(env, queryId, fid, eligible).catch(() => undefined);
    }

    return eligible
      ? { eligible: true, reason: 'open', closesAt: query.closes_at ?? undefined }
      : { eligible: false, reason: 'not_holder' };
  }

  /**
   * Convenience: load the eligibility-relevant columns for a query and run
   * the check in one call. Used by the debug route and the
   * `/api/queries/:id/eligibility` endpoint.
   */
  static async checkById(
    env: Env,
    queryId: string,
    fid: number,
  ): Promise<EligibilityResult | null> {
    const row = (await env.DB.prepare(
      'SELECT closes_at, eligibility_gate FROM queries WHERE id = ? LIMIT 1',
    )
      .bind(queryId)
      .first()) as { closes_at: string | null; eligibility_gate: string | null } | null;
    if (!row) return null;
    return this.check(env, row, fid, queryId);
  }
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

function cacheKey(queryId: string, fid: number): string {
  return `poll:eligible:${queryId}:${fid}`;
}

async function readCache(env: Env, queryId: string, fid: number): Promise<boolean | null> {
  try {
    const raw = await env.KV_USER_PROFILES.get(cacheKey(queryId, fid));
    if (raw === '1') return true;
    if (raw === '0') return false;
    return null;
  } catch {
    return null;
  }
}

async function writeCache(
  env: Env,
  queryId: string,
  fid: number,
  eligible: boolean,
): Promise<void> {
  await env.KV_USER_PROFILES.put(
    cacheKey(queryId, fid),
    eligible ? '1' : '0',
    { expirationTtl: ELIGIBILITY_CACHE_TTL_S },
  );
}

// Re-export Query type for callers that want a stricter shape.
export type { Query };
