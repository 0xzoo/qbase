/**
 * Polls (waves) API routes
 *
 * - POST /api/polls                  — open a wave on an existing question (free)
 * - GET  /api/polls/:id              — public wave + question summary
 * - GET  /api/polls/:id/eligibility  — eligibility probe for a viewer FID
 *
 * A wave is the re-ask primitive: a fresh, time-bounded dataset over a
 * durable question with zero inherited stats. See
 * docs/specs/question-wave-attribution.md.
 */

import { requireFlexibleAuth } from '../middleware/auth';
import { ensureUserExists } from '../middleware/userAutoCreate';
import { RateLimitService } from '../services/RateLimitService';
import { EligibilityService } from '../services/EligibilityService';
import { getPoll, toPublicPoll } from '../services/PollService';
import { openWave } from '../services/WaveService';
import type { PollSubmission } from '../../src/lib/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

const POLL_ID_RE = /^\/api\/polls\/([a-zA-Z0-9_-]+)$/;
const POLL_ELIGIBILITY_RE = /^\/api\/polls\/([a-zA-Z0-9_-]+)\/eligibility$/;

export async function handlePollsRoutes(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/polls')) return null;

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const rateLimitService = RateLimitService.fromEnv(env);

  // POST /api/polls — open a wave on an existing question.
  if (url.pathname === '/api/polls' && request.method === 'POST') {
    const allowed = await rateLimitService.checkLimit(ip, 10, 60, 'polls:create');
    if (!allowed) return new Response('Too Many Requests', { status: 429 });

    const auth = await requireFlexibleAuth(request, env);
    if (!auth.authenticated || !auth.fid) {
      return new Response(auth.error || 'Unauthorized', { status: 401 });
    }
    const userRow = await ensureUserExists(env, auth.fid);
    if (!userRow) return new Response('Failed to create/retrieve user', { status: 500 });

    let body: PollSubmission;
    try {
      body = await request.json() as PollSubmission;
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }
    if (!body || typeof body.question_id !== 'string' || !body.question_id) {
      return Response.json({ error: 'question_id is required' }, { status: 400 });
    }

    const result = await openWave(env, {
      question_id: body.question_id,
      closes_at: body.closes_at,
      eligibility_gate: body.eligibility_gate ?? null,
      options_config: body.options_config ?? null,
      channel_id: body.channel_id ?? null,
      kind: body.kind ?? 'measure',
      resnapshot: body.resnapshot === true,
      author_fid: auth.fid,
    });
    if (!result.ok) {
      return Response.json({ error: result.error, code: result.code }, { status: result.status });
    }
    return Response.json({
      success: true,
      poll: toPublicPoll(result.poll),
      question: result.question,
      ...(result.snapshot ? { snapshot: result.snapshot } : {}),
    });
  }

  // GET /api/polls/:id/eligibility?fid=N
  const eligibilityMatch = url.pathname.match(POLL_ELIGIBILITY_RE);
  if (eligibilityMatch && request.method === 'GET') {
    const allowed = await rateLimitService.checkLimit(ip, 120, 60, 'polls:eligibility');
    if (!allowed) return new Response('Too Many Requests', { status: 429 });
    const fidParam = url.searchParams.get('fid');
    if (!fidParam) return Response.json({ error: 'fid query param required' }, { status: 400 });
    const fid = parseInt(fidParam, 10);
    if (!Number.isFinite(fid)) return Response.json({ error: 'fid must be numeric' }, { status: 400 });
    const result = await EligibilityService.checkById(env, eligibilityMatch[1], fid);
    if (!result) return Response.json({ error: 'poll not found' }, { status: 404 });
    return Response.json(result);
  }

  // GET /api/polls/:id
  const pollMatch = url.pathname.match(POLL_ID_RE);
  if (pollMatch && request.method === 'GET') {
    const allowed = await rateLimitService.checkLimit(ip, 120, 60, 'polls:get');
    if (!allowed) return new Response('Too Many Requests', { status: 429 });
    const poll = await getPoll(env.DB, pollMatch[1]);
    if (!poll) return Response.json({ error: 'poll not found' }, { status: 404 });
    const question = await env.DB.prepare(
      'SELECT id, stem, type, coiner_fname, coiner_fid FROM queries WHERE id = ? LIMIT 1',
    ).bind(poll.question_id).first();
    return Response.json(
      { poll: toPublicPoll(poll), question: question ?? null },
      { headers: { 'Cache-Control': 'public, max-age=10' } },
    );
  }

  return null;
}
