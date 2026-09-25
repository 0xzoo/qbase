/**
 * Human-approved agent actions (plan §6, World ID for Agents).
 *
 * - POST /api/agent/waves/drafts          — { question_id, wave }: the agent drafts a wave
 * - POST /api/agent/waves/:draftId/publish — ask the owner: starts an IdP device
 *   authorization and returns only user_code + verification URIs (the
 *   device_code never leaves the server)
 * - GET  /api/agent/approvals/:id          — status; advances the approval by at
 *   most one token request when one is due
 *
 * Agents authenticate with a bearer key from AGENT_API_KEYS ({"qgent": "<key>"}).
 * No route lets an agent mark anything approved, and none writes an answer.
 * Everything here 404s unless AGENT_APPROVAL_ENABLED is "1".
 */

import { RateLimitService } from '../services/RateLimitService';
import { idpConfig, IdpError } from '../services/WorldIdpService';
import {
  createDraft, getApproval, getDraft, pollApproval, startApproval, type ApprovalRow, type Deps,
} from '../services/AgentApprovalService';
import { publishApprovedDraft, validateDraftWave, type PublishResult } from '../services/AgentPublishService';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

const DRAFTS_RE = /^\/api\/agent\/waves\/drafts$/;
const PUBLISH_RE = /^\/api\/agent\/waves\/([a-zA-Z0-9_-]+)\/publish$/;
const APPROVAL_RE = /^\/api\/agent\/approvals\/([a-zA-Z0-9_-]+)$/;

const json = (body: unknown, status = 200) => Response.json(body, { status });

async function sha256(s: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
}

/** Resolve the calling agent from its bearer key. Compares digests in constant time. */
export async function authenticateAgent(request: Request, env: Env): Promise<string | null> {
  const m = (request.headers.get('Authorization') ?? '').match(/^Bearer\s+(.+)$/);
  if (!m) return null;
  let keys: Record<string, string>;
  try {
    keys = JSON.parse(env.AGENT_API_KEYS ?? '{}');
  } catch {
    return null;
  }
  const presented = await sha256(m[1].trim());
  let found: string | null = null;
  for (const [agentId, key] of Object.entries(keys)) {
    if (typeof key !== 'string' || key.length < 16) continue;
    // timingSafeEqual is a Workers extension to SubtleCrypto.
    const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual(a: ArrayBuffer, b: ArrayBuffer): boolean };
    if (subtle.timingSafeEqual(presented, await sha256(key))) found = agentId;
  }
  return found;
}

function approvalView(a: ApprovalRow, draftStatus?: string) {
  const pending = a.status === 'pending';
  return {
    approval_id: a.id,
    draft_id: a.draft_id,
    status: a.status,
    reason: a.reason,
    expires_at: a.expires_at,
    decided_at: a.decided_at,
    ...(draftStatus ? { draft_status: draftStatus } : {}),
    // While pending the agent may need to relay the link again.
    ...(pending ? {
      user_code: a.user_code,
      verification_uri: a.verification_uri,
      verification_uri_complete: a.verification_uri_complete,
      poll_after_s: a.interval_s,
    } : {}),
  };
}

export async function handleAgentApprovalRoutes(request: Request, env: Env, deps?: Deps): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  const draftsMatch = DRAFTS_RE.test(pathname);
  const publishMatch = draftsMatch ? null : pathname.match(PUBLISH_RE);
  const approvalMatch = draftsMatch || publishMatch ? null : pathname.match(APPROVAL_RE);
  if (!draftsMatch && !publishMatch && !approvalMatch) return null;

  if (env.AGENT_APPROVAL_ENABLED !== '1') return json({ error: 'Not found' }, 404);

  const wantMethod = approvalMatch ? 'GET' : 'POST';
  if (request.method !== wantMethod) return json({ error: 'Method not allowed' }, 405);

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const allowed = await RateLimitService.fromEnv(env).checkLimit(ip, 60, 60, 'agent:approvals');
  if (!allowed) return new Response('Too Many Requests', { status: 429 });

  const agentId = await authenticateAgent(request, env);
  if (!agentId) return json({ error: 'Unauthorized' }, 401);

  const cfg = idpConfig(env);
  if (!cfg) return json({ error: 'World ID IdP is not configured on this deploy', code: 'idp_not_configured' }, 503);

  if (draftsMatch) {
    let body: { question_id?: unknown; wave?: unknown };
    try {
      body = await request.json() as typeof body;
    } catch {
      return json({ error: 'Invalid JSON' }, 400);
    }
    if (typeof body?.question_id !== 'string' || !body.question_id) return json({ error: 'question_id is required' }, 400);
    if (body.wave !== undefined && (typeof body.wave !== 'object' || body.wave === null || Array.isArray(body.wave))) {
      return json({ error: 'wave must be an object' }, 400);
    }
    const checked = validateDraftWave(body.wave);
    if (!checked.ok) return json({ error: checked.error, code: checked.code }, 400);
    const q = await env.DB.prepare('SELECT 1 FROM queries WHERE id = ?').bind(body.question_id).first();
    if (!q) return json({ error: 'Question not found', code: 'question_not_found' }, 404);
    const draft = await createDraft(env, agentId, body.question_id, checked.wave, deps);
    return json({ draft_id: draft.id, status: draft.status }, 201);
  }

  if (publishMatch) {
    const draft = await getDraft(env, publishMatch[1]);
    if (!draft || draft.agent_id !== agentId) return json({ error: 'Draft not found' }, 404);
    try {
      const r = await startApproval(env, cfg, draft, deps);
      if (!r.ok) return json({ error: 'This draft is already approved', code: r.code }, 409);
      return json(approvalView(r.approval, draft.status), r.reused ? 200 : 202);
    } catch (e) {
      const code = e instanceof IdpError ? e.code : 'idp_error';
      console.error('[agent-approvals] device authorization failed', code);
      return json({ error: 'Could not start the approval', code }, 502);
    }
  }

  const existing = await getApproval(env, approvalMatch![1]);
  if (!existing || existing.agent_id !== agentId) return json({ error: 'Approval not found' }, 404);
  const row = await pollApproval(env, cfg, existing.id, deps);
  // An approved draft is published on the read that sees it approved (the
  // same poll-on-read model as the approval itself); the claim inside makes
  // this safe under concurrent reads.
  let publish: PublishResult | undefined;
  if (row?.status === 'approved') {
    publish = await publishApprovedDraft(env, existing.draft_id);
  }
  const draft = await getDraft(env, existing.draft_id);
  return json({
    ...approvalView(row!, draft?.status),
    ...(draft?.poll_id ? { poll_id: draft.poll_id } : {}),
    ...(draft?.publish_error ? { publish_error: draft.publish_error } : {}),
    ...(publish?.status === 'published' ? { cast: publish.cast } : {}),
  });
}
