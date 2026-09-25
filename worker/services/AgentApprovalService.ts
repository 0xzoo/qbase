/**
 * Human-approved agent actions (plan §6): an agent drafts a wave, and only a
 * fresh World ID approval from the agent's owner, redeemed and validated by
 * qbase, moves the draft to approved.
 *
 * Polling is poll-on-read: the status route calls pollApproval, which makes at
 * most one token request, and only once next_poll_at has passed. The claim on
 * next_poll_at is a conditional UPDATE, so concurrent readers cannot poll
 * twice inside one interval (which the IdP would answer with slow_down).
 * Nothing holds a request open.
 */

import {
  discover, fetchJwks, IdpError, redeemDeviceCode, requestDeviceAuthorization, verifyIdToken, type IdpConfig,
} from './WorldIdpService';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

export interface Deps { fetchImpl?: typeof fetch; now?: () => number }
const nowS = (deps?: Deps) => (deps?.now ? deps.now() : Math.floor(Date.now() / 1000));

export const SLOW_DOWN_STEP_S = 5;
/** Plan §6.2: bound every attempt by 20 minutes, whatever expires_in says. */
export const MAX_ATTEMPT_S = 20 * 60;

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'failed' | 'wrong_human' | 'invalid_token';

export interface ApprovalRow {
  id: string;
  draft_id: string;
  agent_id: string;
  device_code_ct: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string | null;
  status: ApprovalStatus;
  reason: string | null;
  interval_s: number;
  next_poll_at: number;
  requested_at: number;
  expires_at: number;
  decided_at: number | null;
  iss: string | null;
  sub: string | null;
  auth_time: number | null;
}

export interface DraftRow {
  id: string;
  agent_id: string;
  question_id: string;
  wave: string;
  status: 'draft' | 'approved' | 'published';
  created_at: number;
  approved_at: number | null;
}

// ── State machine (pure) ─────────────────────────────────────────────────

export type TokenOutcome =
  | { kind: 'pending' }
  | { kind: 'slow_down' }
  | { kind: 'stop'; status: 'denied' | 'expired' | 'failed'; reason: string }
  | { kind: 'token'; idToken: string };

/** Classify one token-endpoint response (RFC 8628 §3.5). */
export function classifyTokenResponse(status: number, body: Record<string, unknown>): TokenOutcome {
  if (status === 200) {
    return typeof body.id_token === 'string' && body.id_token
      ? { kind: 'token', idToken: body.id_token }
      : { kind: 'stop', status: 'failed', reason: 'no_id_token' };
  }
  if (status === 503) return { kind: 'stop', status: 'failed', reason: 'idp_unavailable' };
  switch (body.error) {
    case 'authorization_pending': return { kind: 'pending' };
    case 'slow_down': return { kind: 'slow_down' };
    case 'access_denied': return { kind: 'stop', status: 'denied', reason: 'access_denied' };
    case 'expired_token': return { kind: 'stop', status: 'expired', reason: 'expired_token' };
    case 'invalid_grant': return { kind: 'stop', status: 'failed', reason: 'invalid_grant' };
    default: return { kind: 'stop', status: 'failed', reason: `token_error:${String(body.error ?? status)}` };
  }
}

export type NextState =
  | { status: 'pending'; interval_s: number; next_poll_at: number }
  | { status: 'denied' | 'expired' | 'failed'; reason: string };

/** Where a pending approval goes after a non-token outcome. slow_down raises the interval for every later poll. */
export function nextState(row: Pick<ApprovalRow, 'interval_s'>, outcome: Exclude<TokenOutcome, { kind: 'token' }>, now: number): NextState {
  if (outcome.kind === 'stop') return { status: outcome.status, reason: outcome.reason };
  const interval_s = outcome.kind === 'slow_down' ? row.interval_s + SLOW_DOWN_STEP_S : row.interval_s;
  return { status: 'pending', interval_s, next_poll_at: now + interval_s };
}

// ── Device code at rest ──────────────────────────────────────────────────

async function deviceCodeKey(cfg: IdpConfig): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey('raw', new TextEncoder().encode(cfg.clientSecret), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode('qbase agent_approvals device_code v1') },
    ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

const toB64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const fromB64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));

/** AES-GCM, bound to the approval id as additional data so a ciphertext cannot be moved to another row. */
export async function sealDeviceCode(cfg: IdpConfig, approvalId: string, deviceCode: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(approvalId) },
    await deviceCodeKey(cfg), new TextEncoder().encode(deviceCode),
  ));
  return `${toB64(iv)}.${toB64(ct)}`;
}

export async function openDeviceCode(cfg: IdpConfig, approvalId: string, sealed: string): Promise<string> {
  const [iv, ct] = sealed.split('.');
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64(iv), additionalData: new TextEncoder().encode(approvalId) },
    await deviceCodeKey(cfg), fromB64(ct),
  );
  return new TextDecoder().decode(pt);
}

// ── Drafts ───────────────────────────────────────────────────────────────

export async function createDraft(env: Env, agentId: string, questionId: string, wave: unknown, deps?: Deps): Promise<DraftRow> {
  const row: DraftRow = {
    id: crypto.randomUUID(), agent_id: agentId, question_id: questionId, wave: JSON.stringify(wave ?? {}),
    status: 'draft', created_at: nowS(deps), approved_at: null,
  };
  await env.DB.prepare(
    'INSERT INTO agent_wave_drafts (id, agent_id, question_id, wave, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).bind(row.id, row.agent_id, row.question_id, row.wave, row.status, row.created_at).run();
  return row;
}

export async function getDraft(env: Env, draftId: string): Promise<DraftRow | null> {
  return await env.DB.prepare('SELECT * FROM agent_wave_drafts WHERE id = ?').bind(draftId).first() as DraftRow | null;
}

export async function getApproval(env: Env, approvalId: string): Promise<ApprovalRow | null> {
  return await env.DB.prepare('SELECT * FROM agent_approvals WHERE id = ?').bind(approvalId).first() as ApprovalRow | null;
}

// ── Start ────────────────────────────────────────────────────────────────

export type StartResult =
  | { ok: true; approval: ApprovalRow; reused: boolean }
  | { ok: false; code: 'already_approved' };

/**
 * Ask the IdP for a device authorization for this draft. If an approval is
 * already pending (and not past its expiry) it is returned instead, so a
 * retrying agent does not mint a second code.
 */
export async function startApproval(env: Env, cfg: IdpConfig, draft: DraftRow, deps?: Deps): Promise<StartResult> {
  if (draft.status !== 'draft') return { ok: false, code: 'already_approved' };
  const now = nowS(deps);

  const pending = await env.DB.prepare(
    "SELECT * FROM agent_approvals WHERE draft_id = ? AND status = 'pending'",
  ).bind(draft.id).first() as ApprovalRow | null;
  if (pending) {
    if (now < pending.expires_at) return { ok: true, approval: pending, reused: true };
    await env.DB.prepare(
      "UPDATE agent_approvals SET status = 'expired', reason = 'expired_local', decided_at = ? WHERE id = ? AND status = 'pending'",
    ).bind(now, pending.id).run();
  }

  const fetchImpl = deps?.fetchImpl ?? fetch;
  const d = await discover(cfg, fetchImpl);
  const da = await requestDeviceAuthorization(cfg, d, fetchImpl);
  const id = crypto.randomUUID();
  const row: ApprovalRow = {
    id, draft_id: draft.id, agent_id: draft.agent_id,
    device_code_ct: await sealDeviceCode(cfg, id, da.device_code),
    user_code: da.user_code, verification_uri: da.verification_uri,
    verification_uri_complete: da.verification_uri_complete ?? null,
    status: 'pending', reason: null,
    interval_s: da.interval, next_poll_at: now + da.interval,
    requested_at: now, expires_at: now + Math.min(da.expires_in, MAX_ATTEMPT_S),
    decided_at: null, iss: null, sub: null, auth_time: null,
  };
  try {
    await env.DB.prepare(
      `INSERT INTO agent_approvals (id, draft_id, agent_id, device_code_ct, user_code, verification_uri,
         verification_uri_complete, status, interval_s, next_poll_at, requested_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
    ).bind(
      row.id, row.draft_id, row.agent_id, row.device_code_ct, row.user_code, row.verification_uri,
      row.verification_uri_complete, row.interval_s, row.next_poll_at, row.requested_at, row.expires_at,
    ).run();
  } catch (e) {
    // Lost a race with a concurrent start: the one-pending index kept the other row.
    const winner = await env.DB.prepare(
      "SELECT * FROM agent_approvals WHERE draft_id = ? AND status = 'pending'",
    ).bind(draft.id).first() as ApprovalRow | null;
    if (winner) return { ok: true, approval: winner, reused: true };
    throw e;
  }
  return { ok: true, approval: row, reused: false };
}

// ── Poll ─────────────────────────────────────────────────────────────────

async function finish(env: Env, id: string, status: ApprovalStatus, reason: string, now: number): Promise<void> {
  await env.DB.prepare(
    "UPDATE agent_approvals SET status = ?, reason = ?, decided_at = ? WHERE id = ? AND status = 'pending'",
  ).bind(status, reason, now, id).run();
}

/**
 * Advance a pending approval by at most one token request. Returns the row as
 * it stands afterwards. Safe to call as often as a client likes.
 */
export async function pollApproval(env: Env, cfg: IdpConfig, approvalId: string, deps?: Deps): Promise<ApprovalRow | null> {
  const row = await getApproval(env, approvalId);
  if (!row || row.status !== 'pending') return row;
  const now = nowS(deps);

  if (now >= row.expires_at) {
    await finish(env, row.id, 'expired', 'expired_local', now);
    return getApproval(env, approvalId);
  }
  if (now < row.next_poll_at) return row;

  // Claim this poll slot. Only one caller per interval gets changes = 1.
  const claim = await env.DB.prepare(
    "UPDATE agent_approvals SET next_poll_at = ? WHERE id = ? AND status = 'pending' AND next_poll_at <= ?",
  ).bind(now + row.interval_s, row.id, now).run();
  if (!claim.meta?.changes) return getApproval(env, approvalId);

  const fetchImpl = deps?.fetchImpl ?? fetch;
  let outcome: TokenOutcome;
  let d;
  try {
    d = await discover(cfg, fetchImpl);
    const deviceCode = await openDeviceCode(cfg, row.id, row.device_code_ct);
    const res = await redeemDeviceCode(cfg, d, deviceCode, fetchImpl);
    outcome = classifyTokenResponse(res.status, res.body);
  } catch (e) {
    // Network trouble or a discovery hiccup: stay pending, the claim already pushed next_poll_at.
    console.warn('[agent-approvals] poll failed, will retry', row.id, e instanceof Error ? e.message : e);
    return getApproval(env, approvalId);
  }

  if (outcome.kind !== 'token') {
    const next = nextState(row, outcome, now);
    if (next.status === 'pending') {
      await env.DB.prepare(
        "UPDATE agent_approvals SET interval_s = ?, next_poll_at = ? WHERE id = ? AND status = 'pending'",
      ).bind(next.interval_s, next.next_poll_at, row.id).run();
    } else {
      await finish(env, row.id, next.status, next.reason, now);
    }
    return getApproval(env, approvalId);
  }

  let claims;
  try {
    const jwks = await fetchJwks(d, fetchImpl);
    claims = await verifyIdToken(outcome.idToken, {
      issuer: cfg.issuer, audience: cfg.clientId, jwks, notBefore: row.requested_at, now,
    });
  } catch (e) {
    await finish(env, row.id, 'invalid_token', e instanceof IdpError ? e.code : 'validation_error', now);
    return getApproval(env, approvalId);
  }

  await bindAndApprove(env, row, claims.iss, claims.sub, claims.auth_time, now);
  return getApproval(env, approvalId);
}

/**
 * One D1 batch: the first validated approval for an agent binds its owner;
 * the approval is approved only if (iss, sub) is that owner, otherwise it is
 * wrong_human; the draft moves to approved only if the approval did.
 */
async function bindAndApprove(env: Env, row: ApprovalRow, iss: string, sub: string, authTime: number, now: number): Promise<void> {
  const isOwner = 'EXISTS (SELECT 1 FROM agent_owners WHERE agent_id = ? AND iss = ? AND sub = ?)';
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO agent_owners (agent_id, iss, sub, bound_at) VALUES (?, ?, ?, ?)')
      .bind(row.agent_id, iss, sub, now),
    env.DB.prepare(
      `UPDATE agent_approvals
          SET status = CASE WHEN ${isOwner} THEN 'approved' ELSE 'wrong_human' END,
              reason = CASE WHEN ${isOwner} THEN NULL ELSE 'not_the_owner' END,
              iss = ?, sub = ?, auth_time = ?, decided_at = ?
        WHERE id = ? AND status = 'pending'`,
    ).bind(row.agent_id, iss, sub, row.agent_id, iss, sub, iss, sub, authTime, now, row.id),
    env.DB.prepare(
      `UPDATE agent_wave_drafts SET status = 'approved', approved_at = ?
        WHERE id = ? AND status = 'draft'
          AND EXISTS (SELECT 1 FROM agent_approvals WHERE id = ? AND status = 'approved')`,
    ).bind(now, row.draft_id, row.id),
  ]);
}
