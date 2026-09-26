/**
 * WorldIdService — verified-human answering on `world_id` waves (IDKit v4).
 *
 * Flow (plan §5.2):
 *   1. `signRpContext`: the backend signs an rp_context for the wave's action
 *      (`qbase-wave-<poll_id>`, TTL 300 s). The client passes it unmodified to
 *      `IDKit.request({ app_id, action, rp_context, environment })`.
 *   2. `verifyProof`: the IDKit result goes unmodified to World's verify API
 *      (`POST developer.world.org/api/v4/verify/{rp_id}`, the one endpoint for
 *      every environment). We then assert the response's environment and
 *      action, and that the proof is the proof-of-human credential.
 *   3. `claimNullifier` / `releaseNullifier`: the nullifier is recorded in
 *      `world_verifications` before the answer is written; UNIQUE(action,
 *      nullifier) turns a second answer from the same human, on any account,
 *      into 409. If the answer write fails the claim is released, so a failed
 *      answer does not use up the human's attempt.
 *
 * `world_verifications` has no account column and no answer id: it records
 * that a human answered a wave, never which account did.
 *
 * Config: WORLD_APP_ID, WORLD_RP_ID, WORLD_ENVIRONMENT ("sandbox" on staging,
 * "production" in prod) and the secret WORLD_RP_SIGNING_KEY (32-byte hex);
 * off production, WORLD_STAGING_VERIFICATION_TOKEN (see WorldConfig).
 */

import { signRequest } from '@worldcoin/idkit-core/signing';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

export const WORLD_VERIFY_BASE = 'https://developer.world.org/api/v4/verify';
export const RP_CONTEXT_TTL_S = 300;
export const WORLD_CREDENTIAL = 'proof_of_human';

export type WorldEnvironment = 'production' | 'staging' | 'sandbox';

export interface WorldConfig {
  appId: string;
  rpId: string;
  environment: WorldEnvironment;
  signingKey: string;
  /** Sandbox/staging proofs only verify inside a 24 h window opened in the
   *  Developer Portal (MCP `set_world_id_staging_verification`), which issues
   *  this token. Secret WORLD_STAGING_VERIFICATION_TOKEN; never sent in production. */
  stagingToken?: string;
}

/** The World action a wave's proofs are scoped to. One per wave. */
export function worldAction(pollId: string): string {
  return `qbase-wave-${pollId}`;
}

/** Config from env, or null when World ID is not set up on this deploy. */
export function worldConfig(env: Env): WorldConfig | null {
  const appId = env.WORLD_APP_ID;
  const rpId = env.WORLD_RP_ID;
  const signingKey = env.WORLD_RP_SIGNING_KEY;
  const environment = env.WORLD_ENVIRONMENT;
  if (!appId || !rpId || !signingKey) return null;
  if (environment !== 'production' && environment !== 'staging' && environment !== 'sandbox') return null;
  const stagingToken = environment !== 'production' && env.WORLD_STAGING_VERIFICATION_TOKEN ? String(env.WORLD_STAGING_VERIFICATION_TOKEN) : undefined;
  return { appId, rpId, environment, signingKey, ...(stagingToken ? { stagingToken } : {}) };
}

export interface RpContextPayload {
  app_id: string;
  action: string;
  environment: WorldEnvironment;
  rp_context: {
    rp_id: string;
    nonce: string;
    created_at: number;
    expires_at: number;
    signature: string;
  };
}

/** Sign an rp_context for one proof request on this wave. */
export function signRpContext(cfg: WorldConfig, pollId: string): RpContextPayload {
  const action = worldAction(pollId);
  const sig = signRequest({ signingKeyHex: cfg.signingKey, action, ttl: RP_CONTEXT_TTL_S });
  return {
    app_id: cfg.appId,
    action,
    environment: cfg.environment,
    rp_context: {
      rp_id: cfg.rpId,
      nonce: sig.nonce,
      created_at: sig.createdAt,
      expires_at: sig.expiresAt,
      signature: sig.sig,
    },
  };
}

export type VerifyOutcome =
  | { ok: true; nullifier: string; action: string }
  | { ok: false; status: number; code: string; error: string; detail?: string };

/**
 * Nullifiers arrive as hex field elements. Stored as the decimal string (see
 * migration 0073), so the same value always has one spelling.
 */
export function normalizeNullifier(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return null;
  const s = raw.trim();
  if (!/^(0x[0-9a-fA-F]{1,64}|[0-9]{1,78})$/.test(s)) return null;
  const n = BigInt(s);
  if (n >= 1n << 256n) return null;
  return n.toString(10);
}

/**
 * Check the IDKit result's shape against this wave, send it unmodified to
 * World, and assert what World says back. Never throws on World's answer;
 * a network failure maps to 502.
 */
export async function verifyProof(
  cfg: WorldConfig,
  pollId: string,
  idkitResult: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<VerifyOutcome> {
  const expectedAction = worldAction(pollId);
  const r = idkitResult as Record<string, unknown> | null;
  if (!r || typeof r !== 'object') {
    return { ok: false, status: 400, code: 'world_proof_invalid', error: 'Missing World ID proof' };
  }
  // v4 uniqueness proofs only: v3 nullifiers are a different space, so
  // accepting both would let one human answer twice.
  if (r.protocol_version !== '4.0' || 'session_id' in r) {
    return { ok: false, status: 400, code: 'world_proof_invalid', error: 'A World ID 4.0 uniqueness proof is required' };
  }
  if (r.action !== expectedAction) {
    return { ok: false, status: 400, code: 'world_action_mismatch', error: 'This proof was made for a different poll' };
  }
  const responses = Array.isArray(r.responses) ? r.responses as Array<Record<string, unknown>> : [];
  if (responses.length !== 1 || responses[0]?.identifier !== WORLD_CREDENTIAL) {
    return { ok: false, status: 400, code: 'world_credential_mismatch', error: 'This poll needs the proof-of-human credential' };
  }

  let res: Response;
  try {
    res = await fetchImpl(`${WORLD_VERIFY_BASE}/${encodeURIComponent(cfg.rpId)}`, {
      method: 'POST',
      // developer.world.org answers 403 (HTML) to requests without a User-Agent,
      // and a Worker's fetch sends none.
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'qbase (+https://qbase.tech)',
        ...(cfg.stagingToken ? { 'x-staging-verification-token': cfg.stagingToken } : {}),
      },
      body: JSON.stringify(idkitResult),
    });
  } catch (e) {
    console.error('[WorldId] verify request failed:', e instanceof Error ? e.message : e);
    return { ok: false, status: 502, code: 'world_unreachable', error: 'Could not reach World ID to verify the proof' };
  }

  let body: Record<string, unknown> = {};
  try {
    body = await res.json() as Record<string, unknown>;
  } catch { /* non-JSON error page */ }

  if (!res.ok || body.success !== true) {
    const code = typeof body.code === 'string' ? body.code : `http_${res.status}`;
    const detail = typeof body.detail === 'string' ? body.detail : undefined;
    console.warn(`[WorldId] verify rejected: ${code}${detail ? ` (${detail})` : ''}`);
    return { ok: false, status: 400, code: 'world_verify_failed', error: 'World ID could not verify this proof', detail: code };
  }
  if (body.environment !== cfg.environment) {
    console.warn(`[WorldId] environment mismatch: got ${String(body.environment)}, expected ${cfg.environment}`);
    return { ok: false, status: 400, code: 'world_environment_mismatch', error: `Proof is from the ${String(body.environment)} environment` };
  }
  if (body.action !== undefined && body.action !== expectedAction) {
    return { ok: false, status: 400, code: 'world_action_mismatch', error: 'This proof was made for a different poll' };
  }
  const nullifier = normalizeNullifier(body.nullifier);
  if (!nullifier) {
    return { ok: false, status: 502, code: 'world_response_invalid', error: 'World ID returned no usable nullifier' };
  }
  return { ok: true, nullifier, action: expectedAction };
}

/**
 * Record that this human answered this wave. false = the (action, nullifier)
 * pair is already there: the same human answered before, on some account.
 */
export async function claimNullifier(
  db: D1Database,
  action: string,
  nullifier: string,
  pollId: string,
): Promise<boolean> {
  const res = await db.prepare(
    `INSERT OR IGNORE INTO world_verifications (action, nullifier, poll_id, created_at) VALUES (?, ?, ?, ?)`,
  ).bind(action, nullifier, pollId, new Date().toISOString()).run();
  return (res.meta?.changes ?? 0) === 1;
}

/** Undo a claim whose answer was not written. */
export async function releaseNullifier(db: D1Database, action: string, nullifier: string): Promise<void> {
  await db.prepare('DELETE FROM world_verifications WHERE action = ? AND nullifier = ?')
    .bind(action, nullifier).run();
}
