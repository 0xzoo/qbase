/**
 * Verified-human answering on `world_id` waves (plan §5, IDKit v4).
 *
 * - POST /api/polls/:id/world-context — sign an rp_context for this wave (auth)
 * - POST /api/polls/:id/world-answer  — { answer, idkit_result }: verify the
 *   proof with World, claim its nullifier, then write the answer through the
 *   ordinary create path (auth)
 *
 * Answering is otherwise unchanged: the answer belongs to the logged-in
 * account and takes its audience from the normal chooser. The proof only
 * decides whether this human may answer this wave at all.
 */

import { requireFlexibleAuth } from '../middleware/auth';
import { ensureUserExists } from '../middleware/userAutoCreate';
import { RateLimitService } from '../services/RateLimitService';
import { EligibilityService } from '../services/EligibilityService';
import { getPoll, parsePollGate, type PollRow } from '../services/PollService';
import {
  claimNullifier, releaseNullifier, signRpContext, verifyProof, worldConfig, type WorldConfig,
} from '../services/WorldIdService';
import { handleCreateAnswer } from '../handlers/answers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

const WORLD_CONTEXT_RE = /^\/api\/polls\/([a-zA-Z0-9_-]+)\/world-context$/;
const WORLD_ANSWER_RE = /^\/api\/polls\/([a-zA-Z0-9_-]+)\/world-answer$/;

export async function handlePollWorldRoutes(request: Request, env: Env): Promise<Response | null> {
  if (request.method !== 'POST') return null;
  const { pathname } = new URL(request.url);
  const contextMatch = pathname.match(WORLD_CONTEXT_RE);
  const answerMatch = contextMatch ? null : pathname.match(WORLD_ANSWER_RE);
  if (!contextMatch && !answerMatch) return null;

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const allowed = await RateLimitService.fromEnv(env).checkLimit(ip, 20, 60, 'polls:world');
  if (!allowed) return new Response('Too Many Requests', { status: 429 });

  const auth = await requireFlexibleAuth(request, env);
  if (!auth.authenticated || !auth.fid) {
    return new Response(auth.error || 'Unauthorized', { status: 401 });
  }

  const cfg = worldConfig(env);
  if (!cfg) {
    return Response.json({ error: 'World ID is not configured on this deploy', code: 'world_not_configured' }, { status: 503 });
  }

  const poll = await getPoll(env.DB, (contextMatch ?? answerMatch)![1]);
  if (!poll) return Response.json({ error: 'Poll not found', code: 'poll_not_found' }, { status: 404 });
  if (parsePollGate(poll.eligibility_gate)?.type !== 'world_id') {
    return Response.json({ error: 'This wave does not ask for World ID', code: 'not_world_gated' }, { status: 400 });
  }

  // Closed (or already answered by this account) is decided before the World
  // prompt opens and before a proof is spent.
  const elig = await EligibilityService.check(env, poll, auth.fid, { answeringAsSelf: true });
  if (elig.reason === 'closed') {
    return Response.json(
      { error: 'Voting has closed for this poll', code: 'poll_closed', closes_at: elig.closesAt },
      { status: 423 },
    );
  }

  if (contextMatch) {
    return Response.json({ ...signRpContext(cfg, poll.id), already_verified: elig.eligible });
  }
  return handleWorldAnswer(request, env, cfg, poll, auth.fid, elig.eligible);
}

async function handleWorldAnswer(
  request: Request,
  env: Env,
  cfg: WorldConfig,
  poll: PollRow,
  fid: number,
  alreadyVerified: boolean,
): Promise<Response> {
  let body: { answer?: Record<string, unknown>; idkit_result?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  if (!body?.answer || typeof body.answer !== 'object') {
    return Response.json({ error: 'answer is required' }, { status: 400 });
  }

  const userRow = await ensureUserExists(env, fid);
  if (!userRow) return new Response('Failed to create/retrieve user', { status: 500 });

  return answerWithWorldProof(env, cfg, poll, userRow.id, body.answer, body.idkit_result, alreadyVerified);
}

/**
 * Verify, claim, write. The nullifier is claimed before the answer write so a
 * replayed proof (or the same human on a second account) cannot write twice,
 * and released if the write does not succeed so a failed answer does not use
 * up the human's attempt.
 */
export async function answerWithWorldProof(
  env: Env,
  cfg: WorldConfig,
  poll: PollRow,
  userId: number,
  answer: Record<string, unknown>,
  idkitResult: unknown,
  alreadyVerified: boolean,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  // Same injection as POST /api/answers: the account comes from auth, the
  // question and wave from the URL, never from the body.
  const createRequest = () => new Request('https://qbase.internal/api/answers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...answer, user_id: userId, q_id: poll.question_id, poll_id: poll.id }),
  });

  // This account already answered with a proof: a changed answer needs none.
  if (alreadyVerified) return handleCreateAnswer(createRequest(), env);

  const verified = await verifyProof(cfg, poll.id, idkitResult, fetchImpl);
  if (!verified.ok) {
    return Response.json(
      { error: verified.error, code: verified.code, ...(verified.detail ? { detail: verified.detail } : {}) },
      { status: verified.status },
    );
  }

  if (!(await claimNullifier(env.DB, verified.action, verified.nullifier, poll.id))) {
    return Response.json(
      { error: 'This World ID already answered this wave', code: 'world_id_used' },
      { status: 409 },
    );
  }

  let res: Response;
  try {
    res = await handleCreateAnswer(createRequest(), env, poll.id);
  } catch (e) {
    await releaseNullifier(env.DB, verified.action, verified.nullifier);
    throw e;
  }
  if (!res.ok) await releaseNullifier(env.DB, verified.action, verified.nullifier);
  return res;
}
