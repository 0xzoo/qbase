/**
 * CouncilService — summon the oracle council for a question, paid from the
 * summoner's $QQ stake (docs/specs/paid-council.md).
 *
 * One path for both triggers:
 *   web  — POST /api/queries/:id/council (routes/council.ts)
 *   cast — "@qgent council" reply seen by /webhooks/hypersnap
 *
 * Order of checks: the question exists → the council has not already answered
 * it (answers are shown, nothing charged) → the summon is not a replay
 * (summon_cast_hash UNIQUE / per-question web lock) → per-FID rate limit →
 * stake ≥ COUNCIL_PRICE_QQ (when the gate is on) → dispatch the ORACLE Durable
 * Object → persist council_responses → recordDeduction on Base. A dispatch
 * failure deducts nothing; a deduction failure after answers is logged on the
 * summons row for a manual make-good.
 *
 * Gate: COUNCIL_PRICE_QQ > 0 turns it on. With the price set but no
 * ORACLE_ESCROW_ADDRESS the service refuses (escrow_unconfigured) rather than
 * summoning for free.
 */

import { parseUnits, type Hex } from 'viem';
import { OracleEscrowService, QQ_DECIMALS, type EscrowLike } from './OracleEscrowService';
import { RateLimitService } from './RateLimitService';
import type { OracleDispatchRequest, OracleDispatchResult } from '../agents/OracleAgent';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

export const COUNCIL_MODELS = ['qlaude', 'qemini', 'chatqpt'] as const;
export const STAKE_URL = '/stake';
const SUMMONS_PER_FID_PER_HOUR = 3;
const WEB_LOCK_TTL_S = 120;

export interface CouncilConfig {
  /** Whole $QQ per summon, as configured ('0' = free). */
  price: string;
  priceWei: bigint;
  gated: boolean;
  escrow_address: string | null;
  stake_url: string;
  models: readonly string[];
}

export interface CouncilResponse {
  id: string;
  summon_id: string;
  question_id: string | null;
  model: string;
  text: string;
  cast_hash: string | null;
  model_id: string | null;
  tokens: number | null;
  latency_ms: number | null;
  error: string | null;
  created_at: number;
}

export interface SummonInput {
  /** qbase question being summoned; optional on the cast path when the parent cast is untracked. */
  questionId?: string;
  /** The summoner — pays from their stake. */
  fid: number;
  username?: string;
  source: 'web' | 'cast';
  /** Cast path: the "@qgent council" reply hash (idempotency key). */
  summonCastHash?: string;
  /** Cast the models reply to. Defaults to the question's own cast when tracked. */
  parentCastHash?: string;
  parentAuthorFid?: number;
  /** Question text when there is no qbase question row (untracked cast). */
  questionText?: string;
}

export type SummonResult =
  | { ok: true; status: 'answered' | 'already_answered' | 'replayed'; summonId: string; responses: CouncilResponse[]; price: string }
  | { ok: false; code: 'question_not_found' | 'no_question_text' | 'in_flight' | 'rate_limited' | 'escrow_unconfigured' | 'dispatch_failed'; message: string }
  | { ok: false; code: 'stake_required'; message: string; price: string; balance: string; stake_url: string };

export interface CouncilDeps {
  escrow?: EscrowLike | null;
  /** Dispatch to the ORACLE Durable Object; injectable for tests. */
  oracle?: (payload: OracleDispatchRequest) => Promise<OracleDispatchResult>;
  rateLimit?: (fid: number) => Promise<boolean>;
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export function councilConfig(env: Env): CouncilConfig {
  const raw = String(env.COUNCIL_PRICE_QQ ?? '0').trim();
  const price = /^\d+(\.\d+)?$/.test(raw) ? raw : '0';
  const priceWei = parseUnits(price, QQ_DECIMALS);
  const escrow = env.ORACLE_ESCROW_ADDRESS && /^0x[0-9a-fA-F]{40}$/.test(env.ORACLE_ESCROW_ADDRESS)
    ? String(env.ORACLE_ESCROW_ADDRESS)
    : null;
  return { price, priceWei, gated: priceWei > 0n, escrow_address: escrow, stake_url: STAKE_URL, models: COUNCIL_MODELS };
}

/** Config as the API ships it (no bigint). */
export function publicCouncilConfig(env: Env) {
  const c = councilConfig(env);
  return {
    price: c.price,
    gated: c.gated,
    escrow_address: c.escrow_address,
    qq_address: (env.QQ_CONTRACT_ADDRESS as string | undefined) ?? null,
    stake_url: c.stake_url,
    models: c.models,
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Only answers that arrived; a failed model's row (text '' + error) is audit, not thread. */
const ANSWERED = `text != '' AND error IS NULL`;

export async function listResponses(env: Env, questionId: string, opts: { includeFailed?: boolean } = {}): Promise<CouncilResponse[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM council_responses WHERE question_id = ? ${opts.includeFailed ? '' : `AND ${ANSWERED}`} ORDER BY created_at ASC, model ASC`,
  ).bind(questionId).all();
  return (results ?? []) as CouncilResponse[];
}

async function listResponsesByParentCast(env: Env, parentCastHash: string): Promise<CouncilResponse[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM council_responses WHERE parent_cast_hash = ? AND ${ANSWERED} ORDER BY created_at ASC, model ASC`,
  ).bind(parentCastHash).all();
  return (results ?? []) as CouncilResponse[];
}

async function listResponsesBySummon(env: Env, summonId: string): Promise<CouncilResponse[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM council_responses WHERE summon_id = ? ORDER BY created_at ASC, model ASC`,
  ).bind(summonId).all();
  return (results ?? []) as CouncilResponse[];
}

interface QuestionRow {
  id: string;
  stem: string;
  cast_hash: string | null;
  cast_author_fid: number | null;
}

/** Stem + cast (question_meta first, farcaster_casts for older rows). */
export async function loadQuestionForCouncil(env: Env, questionId: string): Promise<QuestionRow | null> {
  const row = await env.DB.prepare(
    `SELECT q.id, q.stem,
            COALESCE(qm.cast_hash, fc.cast_hash) AS cast_hash,
            COALESCE(qm.author_fid, fc.caster_fid) AS cast_author_fid
       FROM queries q
       LEFT JOIN question_meta qm ON qm.question_id = q.id
       LEFT JOIN farcaster_casts fc ON fc.entity_type = 'query' AND fc.entity_id = q.id
      WHERE q.id = ?`,
  ).bind(questionId).first() as QuestionRow | null;
  return row ?? null;
}

/** The qbase question a cast belongs to, if any. */
export async function questionIdForCast(env: Env, castHash: string): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT question_id AS id FROM question_meta WHERE cast_hash = ?
     UNION ALL
     SELECT entity_id AS id FROM farcaster_casts WHERE entity_type = 'query' AND cast_hash = ?
     LIMIT 1`,
  ).bind(castHash, castHash).first() as { id: string } | null;
  return row?.id ?? null;
}

/** Viewer-facing stake state for a FID (null balance when the escrow is not wired). */
export async function viewerStake(env: Env, fid: number, deps: CouncilDeps = {}): Promise<{ balance: string | null; can_summon: boolean }> {
  const cfg = councilConfig(env);
  if (!cfg.gated) return { balance: null, can_summon: true };
  const escrow = deps.escrow === undefined ? OracleEscrowService.fromEnv(env) : deps.escrow;
  if (!escrow) return { balance: null, can_summon: false };
  try {
    const balance = await escrow.availableBalance(fid);
    return { balance: balance.toString(), can_summon: balance >= cfg.priceWei };
  } catch (err) {
    console.warn('[Council] balance read failed', err);
    return { balance: null, can_summon: false };
  }
}

// ---------------------------------------------------------------------------
// Summon
// ---------------------------------------------------------------------------

export async function summon(env: Env, input: SummonInput, deps: CouncilDeps = {}): Promise<SummonResult> {
  const now = deps.now ?? (() => Date.now());
  const cfg = councilConfig(env);

  // ── 1. The question and the cast the models will reply to ──────────────
  let questionText = input.questionText?.trim() ?? '';
  let parentCastHash = input.parentCastHash ?? null;
  let parentAuthorFid = input.parentAuthorFid ?? null;
  const questionId = input.questionId ?? null;

  if (questionId) {
    const q = await loadQuestionForCouncil(env, questionId);
    if (!q) return { ok: false, code: 'question_not_found', message: 'Question not found' };
    questionText = questionText || q.stem;
    if (!parentCastHash && q.cast_hash && q.cast_author_fid) {
      parentCastHash = q.cast_hash;
      parentAuthorFid = Number(q.cast_author_fid);
    }
  }
  if (!questionText) return { ok: false, code: 'no_question_text', message: 'Nothing to ask the council' };
  if (parentCastHash && !parentAuthorFid) {
    return { ok: false, code: 'no_question_text', message: 'Parent cast author unknown' };
  }

  // ── 2. Already answered (at least one model did) → show, do not charge.
  //       A summon whose every model failed leaves only error rows, so it can be retried.
  const prior = questionId
    ? await listResponses(env, questionId)
    : parentCastHash ? await listResponsesByParentCast(env, parentCastHash) : [];
  if (prior.length > 0) {
    return { ok: true, status: 'already_answered', summonId: prior[0].summon_id, responses: prior, price: '0' };
  }

  // ── 3. Replay / double-click protection ─────────────────────────────────
  if (input.summonCastHash) {
    const existing = await env.DB.prepare(
      `SELECT id, status, price FROM council_summons WHERE summon_cast_hash = ?`,
    ).bind(input.summonCastHash).first() as { id: string; status: string; price: string } | null;
    if (existing) {
      const responses = await listResponsesBySummon(env, existing.id);
      return { ok: true, status: 'replayed', summonId: existing.id, responses, price: existing.price };
    }
  }
  const lockKv: KVNamespace | undefined = env.KV_FRAME_NOTIFICATIONS;
  const lockKey = `council:lock:${questionId ?? parentCastHash}`;
  if (lockKv) {
    if (await lockKv.get(lockKey)) {
      return { ok: false, code: 'in_flight', message: 'The council is already deliberating on this question' };
    }
    await lockKv.put(lockKey, String(now()), { expirationTtl: WEB_LOCK_TTL_S });
  }

  try {
    // ── 4. Rate limit per summoner ────────────────────────────────────────
    const rateLimit = deps.rateLimit ?? defaultRateLimit(env);
    if (!(await rateLimit(input.fid))) {
      return { ok: false, code: 'rate_limited', message: `At most ${SUMMONS_PER_FID_PER_HOUR} summons per hour` };
    }

    // ── 5. Stake gate ─────────────────────────────────────────────────────
    const escrow = deps.escrow === undefined ? OracleEscrowService.fromEnv(env) : deps.escrow;
    if (cfg.gated) {
      if (!escrow) {
        console.error('[Council] COUNCIL_PRICE_QQ is set but ORACLE_ESCROW_ADDRESS is not; refusing');
        return { ok: false, code: 'escrow_unconfigured', message: 'Council payments are not configured yet' };
      }
      const balance = await escrow.availableBalance(input.fid, { fresh: true });
      if (balance < cfg.priceWei) {
        return {
          ok: false,
          code: 'stake_required',
          message: `Summoning the council costs ${cfg.price} $QQ from your stake`,
          price: cfg.price,
          balance: balance.toString(),
          stake_url: cfg.stake_url,
        };
      }
    }

    // ── 6. Record the summon, then dispatch ───────────────────────────────
    const summonId = crypto.randomUUID();
    const createdAt = now();
    await env.DB.prepare(
      `INSERT INTO council_summons (id, question_id, fid, source, summon_cast_hash, parent_cast_hash, price, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    ).bind(summonId, questionId, input.fid, input.source, input.summonCastHash ?? null, parentCastHash, cfg.gated ? cfg.price : '0', createdAt).run();

    const oracle = deps.oracle ?? defaultOracle(env);
    const payload: OracleDispatchRequest = {
      question: questionText,
      models: [...COUNCIL_MODELS],
      askerFid: input.fid,
      askerUsername: input.username ?? '',
      parentHash: parentCastHash ?? undefined,
      parentAuthorFid: parentAuthorFid ?? undefined,
      castText: questionText,
      ledgerKey: parentCastHash ?? `web:${questionId}`,
    };

    let result: OracleDispatchResult;
    try {
      result = await oracle(payload);
    } catch (err) {
      await markFailed(env, summonId, `dispatch threw: ${String(err)}`, now());
      return { ok: false, code: 'dispatch_failed', message: 'The council could not be reached' };
    }
    if (!result.processed) {
      await markFailed(env, summonId, result.error ?? 'not processed', now());
      return { ok: false, code: 'dispatch_failed', message: result.error ?? 'The council did not answer' };
    }

    // ── 7. Persist every model's answer ───────────────────────────────────
    const stmts = result.responses.map(r => env.DB.prepare(
      `INSERT INTO council_responses (id, summon_id, question_id, parent_cast_hash, model, text, cast_hash, model_id, tokens, latency_ms, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(), summonId, questionId, parentCastHash, r.model, r.text ?? '',
      r.hash || null, r.modelId ?? null, r.tokens ?? null, r.latencyMs ?? null, r.error ?? null, now(),
    ));
    if (stmts.length > 0) await env.DB.batch(stmts);

    const answered = result.responses.filter(r => r.text && !r.error);
    if (answered.length === 0) {
      await markFailed(env, summonId, 'every model failed', now());
      return { ok: false, code: 'dispatch_failed', message: 'No model could answer right now' };
    }

    // ── 8. Charge ─────────────────────────────────────────────────────────
    let deductionTx: Hex | null = null;
    let error: string | null = null;
    if (cfg.gated && escrow) {
      try {
        deductionTx = await escrow.recordDeduction(input.fid, cfg.priceWei);
        console.log(`[Council] deducted ${cfg.price} $QQ from fid ${input.fid}: ${deductionTx} (summon ${summonId}, ${answered.length}/${result.responses.length} answered)`);
      } catch (err) {
        error = `deduction_failed: ${String(err).slice(0, 300)}`;
        console.error(`[Council] ${error} — fid ${input.fid}, summon ${summonId}; answers were delivered, make good by hand`);
      }
    }
    await env.DB.prepare(
      `UPDATE council_summons SET status = 'answered', deduction_tx = ?, error = ?, answered_at = ? WHERE id = ?`,
    ).bind(deductionTx, error, now(), summonId).run();

    const responses = await listResponsesBySummon(env, summonId);
    return { ok: true, status: 'answered', summonId, responses, price: cfg.gated ? cfg.price : '0' };
  } finally {
    if (lockKv) await lockKv.delete(lockKey);
  }
}

async function markFailed(env: Env, summonId: string, error: string, at: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE council_summons SET status = 'failed', error = ?, answered_at = ? WHERE id = ?`,
  ).bind(error.slice(0, 500), at, summonId).run();
}

function defaultRateLimit(env: Env): (fid: number) => Promise<boolean> {
  return async (fid) => {
    if (!env.RATE_LIMIT) return true;
    return RateLimitService.fromEnv(env).checkLimit(`fid:${fid}`, SUMMONS_PER_FID_PER_HOUR, 3600, 'council:summon');
  };
}

function defaultOracle(env: Env): (payload: OracleDispatchRequest) => Promise<OracleDispatchResult> {
  return async (payload) => {
    const stub = env.ORACLE.get(env.ORACLE.idFromName('oracle'));
    const response = await stub.fetch('http://oracle/dispatch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(`oracle ${response.status}: ${(await response.text()).slice(0, 200)}`);
    return await response.json() as OracleDispatchResult;
  };
}
