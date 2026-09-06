/**
 * WaveService — opening a wave (poll) over a question.
 *
 * One code path for both entry points:
 *   - POST /api/queries with `closes_at` (create the question AND its first wave)
 *   - POST /api/polls  (open a new wave on an existing question — the re-ask)
 *
 * Rules (docs/specs/question-wave-attribution.md, decisions locked 2026-09-06):
 *   - `closes_at` is required and defines the wave; must be in the future and
 *     within MAX_WAVE_DURATION_MS (1 year — kept deliberately, raise on demand).
 *   - `eligibility_gate` is optional. Snapshots are expensive (Alchemy +
 *     Neynar, ~30s ceiling), so a gate whose params match a prior wave's copies
 *     that wave's resolved `snapshot_fids`; `resnapshot: true` forces a fresh one.
 *   - `options_config` (open options) lives on the wave; the option set is
 *     re-seeded from the question's `a_options` on every wave.
 *   - Wave creation is free (no QP). `kind` defaults to 'measure'; 'decide'
 *     waves arrive in Track D and are rejected here until then.
 */

import type { EligibilityGate, EligibilityGateSubmission } from '../../src/lib/types';
import { snapshotNftHolders } from './NftHolderSnapshotService';
import { snapshotTokenHolders } from './TokenHolderSnapshotService';
import { buildOptionsConfig, seedOptions, type OptionsConfig } from './PollOptionsService';
import { insertPoll, parsePollGate, type PollKind, type PollRow } from './PollService';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

export const MAX_WAVE_DURATION_MS = 365 * 24 * 60 * 60 * 1000;

/** How many prior gated waves to scan for a reusable snapshot. */
const GATE_REUSE_SCAN_LIMIT = 200;

export interface WaveError {
  status: number;
  error: string;
  code?: string;
}

export function validateCloseTime(closesAt: unknown, nowMs: number = Date.now()): WaveError | null {
  if (typeof closesAt !== 'string' || !closesAt) {
    return { status: 400, error: 'closes_at is required — a wave is defined by its close time', code: 'closes_at_required' };
  }
  const closesMs = Date.parse(closesAt);
  if (!Number.isFinite(closesMs)) {
    return { status: 400, error: 'Invalid closes_at — must be ISO 8601', code: 'closes_at_invalid' };
  }
  if (closesMs <= nowMs) {
    return { status: 400, error: 'closes_at must be in the future', code: 'closes_at_past' };
  }
  if (closesMs > nowMs + MAX_WAVE_DURATION_MS) {
    return { status: 400, error: 'closes_at must be within 1 year', code: 'closes_at_too_far' };
  }
  return null;
}

export function validateGateSubmission(gate: unknown): WaveError | null {
  if (!gate || typeof gate !== 'object') {
    return { status: 400, error: 'eligibility_gate must be an object', code: 'gate_invalid' };
  }
  const g = gate as Record<string, unknown>;
  if (g.type !== 'nft_snapshot' && g.type !== 'token_snapshot') {
    return { status: 400, error: 'Unsupported eligibility_gate.type (v0: nft_snapshot | token_snapshot)', code: 'gate_invalid' };
  }
  if (typeof g.contract !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(g.contract)) {
    return { status: 400, error: 'eligibility_gate.contract must be 0x + 40 hex', code: 'gate_invalid' };
  }
  if (g.chain !== 'base') {
    return { status: 400, error: 'eligibility_gate.chain must be "base" (v0)', code: 'gate_invalid' };
  }
  if (g.type === 'token_snapshot') {
    const mb = g.min_balance;
    if (typeof mb !== 'string' || !mb || !/^\d+(\.\d+)?$/.test(mb) || Number(mb) <= 0) {
      return { status: 400, error: 'token_snapshot requires positive numeric min_balance', code: 'gate_invalid' };
    }
  }
  return null;
}

/**
 * Two gates describe the same holder set when type, contract, chain and (for
 * tokens) the human-form threshold agree. Contract compare is case-insensitive.
 */
export function gateParamsMatch(
  a: Pick<EligibilityGateSubmission, 'type' | 'contract' | 'chain'> & { min_balance?: string },
  b: Pick<EligibilityGateSubmission, 'type' | 'contract' | 'chain'> & { min_balance?: string },
): boolean {
  if (a.type !== b.type) return false;
  if (a.chain !== b.chain) return false;
  if (a.contract.toLowerCase() !== b.contract.toLowerCase()) return false;
  if (a.type === 'token_snapshot') {
    return String(a.min_balance ?? '') === String(b.min_balance ?? '');
  }
  return true;
}

/** Most recent prior wave whose resolved gate has identical params, or null. */
export async function findReusableGate(
  db: D1Database,
  submission: EligibilityGateSubmission,
): Promise<{ poll_id: string; gate: EligibilityGate } | null> {
  const { results } = await db
    .prepare(
      `SELECT id, eligibility_gate FROM polls
       WHERE eligibility_gate IS NOT NULL
       ORDER BY created_at DESC, rowid DESC
       LIMIT ?`,
    )
    .bind(GATE_REUSE_SCAN_LIMIT)
    .all();
  for (const row of (results || []) as Array<{ id: string; eligibility_gate: string }>) {
    const gate = parsePollGate(row.eligibility_gate);
    if (!gate || !Array.isArray(gate.snapshot_fids)) continue;
    if (gateParamsMatch(submission, gate)) return { poll_id: row.id, gate };
  }
  return null;
}

export interface ResolvedGate {
  gate: EligibilityGate;
  /** Set when the snapshot was copied from a prior wave instead of re-run. */
  reused_from?: string;
}

/**
 * Resolve a gate submission to a stored gate: reuse a prior identical
 * snapshot unless `resnapshot`, else run the holder pipeline (throws on
 * failure — the caller maps that to 503).
 */
export async function resolveGate(
  env: Env,
  submission: EligibilityGateSubmission,
  opts: { resnapshot?: boolean } = {},
): Promise<ResolvedGate> {
  if (!opts.resnapshot) {
    const prior = await findReusableGate(env.DB, submission);
    if (prior) {
      console.log(`[Wave] Reusing snapshot from wave ${prior.poll_id} (${prior.gate.snapshot_fids.length} FIDs)`);
      return { gate: prior.gate, reused_from: prior.poll_id };
    }
  }

  if (submission.type === 'nft_snapshot') {
    const snap = await snapshotNftHolders(env, { contract: submission.contract, chain: submission.chain });
    const gate: EligibilityGate = {
      type: 'nft_snapshot',
      contract: submission.contract.toLowerCase(),
      chain: submission.chain,
      snapshot_fids: snap.holderFids,
      holder_address_count: snap.holderAddresses.length,
      snapshotted_at: snap.snapshottedAt,
    };
    console.log(`[Wave] NFT snapshot: ${gate.holder_address_count} addresses → ${gate.snapshot_fids.length} verified FIDs`);
    return { gate };
  }

  const snap = await snapshotTokenHolders(env, {
    contract: submission.contract,
    chain: submission.chain,
    min_balance: submission.min_balance,
  });
  const gate: EligibilityGate = {
    type: 'token_snapshot',
    contract: submission.contract.toLowerCase(),
    chain: submission.chain,
    min_balance: submission.min_balance,
    min_balance_wei: snap.minBalanceWei,
    decimals: snap.decimals,
    symbol: snap.symbol,
    snapshot_fids: snap.holderFids,
    holder_address_count: snap.holderAddresses.length,
    snapshotted_at: snap.snapshottedAt,
  };
  console.log(`[Wave] Token snapshot: ${gate.holder_address_count} qualifying addresses (≥${submission.min_balance} ${snap.symbol ?? ''}) → ${gate.snapshot_fids.length} verified FIDs`);
  return { gate };
}

export interface OpenWaveInput {
  question_id: string;
  closes_at: string;
  eligibility_gate?: EligibilityGateSubmission | null;
  /** Skip resolution: the caller already resolved (and paid for) the snapshot. */
  resolved_gate?: ResolvedGate | null;
  options_config?: unknown;
  author_fid?: number | null;
  cast_hash?: string | null;
  channel_id?: string | null;
  kind?: PollKind;
  resnapshot?: boolean;
  created_at?: string;
}

export type OpenWaveResult =
  | {
      ok: true;
      poll: PollRow;
      question: { id: string; type: string; a_options: string[] };
      snapshot?: { holder_address_count: number; holder_fid_count: number; snapshotted_at: string; reused_from?: string };
    }
  | ({ ok: false } & WaveError);

/**
 * Open a wave on an existing question. Validates, resolves the gate (or
 * reuses one), inserts the `polls` row and seeds its option set from the
 * question's declared options when the wave is open-options.
 */
export async function openWave(env: Env, input: OpenWaveInput): Promise<OpenWaveResult> {
  const closeErr = validateCloseTime(input.closes_at);
  if (closeErr) return { ok: false, ...closeErr };

  const kind: PollKind = input.kind ?? 'measure';
  if (kind !== 'measure') {
    return { ok: false, status: 400, error: "Only 'measure' waves can be opened today (decide waves arrive in Track D)", code: 'kind_unavailable' };
  }

  const question = await env.DB.prepare(
    'SELECT id, type, a_options FROM queries WHERE id = ? LIMIT 1',
  ).bind(input.question_id).first() as { id: string; type: string; a_options: string | null } | null;
  if (!question) return { ok: false, status: 404, error: 'Question not found', code: 'question_not_found' };

  let aOptions: string[] = [];
  try {
    const parsed = question.a_options ? JSON.parse(question.a_options) : [];
    if (Array.isArray(parsed)) aOptions = parsed.filter((o): o is string => typeof o === 'string');
  } catch { /* malformed a_options → no seeds */ }

  let optionsConfig: OptionsConfig | null = null;
  if (input.options_config !== undefined && input.options_config !== null) {
    if (question.type !== 'mc') {
      return { ok: false, status: 400, error: 'options_config is only valid for mc questions', code: 'options_config_invalid' };
    }
    optionsConfig = buildOptionsConfig(input.options_config);
    if (!optionsConfig) {
      return { ok: false, status: 400, error: 'Invalid options_config — expected { open: true, cap?, writeins_per_user? }', code: 'options_config_invalid' };
    }
    if (aOptions.length === 0) {
      return { ok: false, status: 400, error: 'Open polls need at least one seed option in a_options', code: 'options_config_invalid' };
    }
  }

  let resolved: ResolvedGate | null = input.resolved_gate ?? null;
  if (!resolved && input.eligibility_gate) {
    const gateErr = validateGateSubmission(input.eligibility_gate);
    if (gateErr) return { ok: false, ...gateErr };
    try {
      resolved = await resolveGate(env, input.eligibility_gate, { resnapshot: input.resnapshot });
    } catch (snapErr: unknown) {
      const msg = snapErr instanceof Error ? snapErr.message : String(snapErr);
      console.error('[Wave] Holder snapshot failed:', msg);
      return { ok: false, status: 503, error: `Holder snapshot failed: ${msg}`, code: 'snapshot_failed' };
    }
  }

  const createdAt = input.created_at ?? new Date().toISOString();
  const poll = await insertPoll(env.DB, {
    question_id: question.id,
    closes_at: input.closes_at,
    eligibility_gate: resolved ? JSON.stringify(resolved.gate) : null,
    options_config: optionsConfig ? JSON.stringify(optionsConfig) : null,
    author_fid: input.author_fid ?? null,
    cast_hash: input.cast_hash ?? null,
    channel_id: input.channel_id ?? null,
    kind,
    created_at: createdAt,
  });

  if (optionsConfig && aOptions.length > 0) {
    try {
      await seedOptions(env.DB, poll.id, aOptions, createdAt, input.author_fid ?? null);
    } catch (seedErr) {
      console.error(`[Wave] poll_options seed failed for wave ${poll.id}:`, seedErr);
    }
  }

  console.log(`[Wave] Opened ${kind} wave ${poll.id} on ${question.id} (closes ${poll.closes_at})`);

  const out: OpenWaveResult = { ok: true, poll, question: { id: question.id, type: question.type, a_options: aOptions } };
  if (resolved) {
    out.snapshot = {
      holder_address_count: resolved.gate.holder_address_count,
      holder_fid_count: resolved.gate.snapshot_fids.length,
      snapshotted_at: resolved.gate.snapshotted_at,
      ...(resolved.reused_from ? { reused_from: resolved.reused_from } : {}),
    };
  }
  return out;
}

