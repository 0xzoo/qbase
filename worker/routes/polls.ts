/**
 * Polls (waves) API routes
 *
 * - POST /api/polls                  — open a wave on an existing question (free)
 * - GET  /api/polls/:id              — public wave + question summary
 * - GET  /api/polls/:id/eligibility  — eligibility probe for a viewer FID
 * - GET  /api/polls/:id/aggregate    — wave-scoped distribution + vote-change signal
 * - GET  /api/polls/:id/options      — visible options of an open wave (declared order)
 * - POST /api/polls/:id/options      — write in an option (or merge) and vote it (auth)
 * - GET  /api/polls/:id/options/all  — all options incl. hidden (creator/admin)
 * - PATCH /api/polls/:id/options/:oid — hide/unhide an option (creator/admin)
 *
 * A wave is the re-ask primitive: a fresh, time-bounded dataset over a
 * durable question with zero inherited stats. See
 * docs/specs/question-wave-attribution.md.
 */

import { requireFlexibleAuth, type AuthResult } from '../middleware/auth';
import { ensureUserExists } from '../middleware/userAutoCreate';
import { RateLimitService } from '../services/RateLimitService';
import { EligibilityService } from '../services/EligibilityService';
import { getPoll, toPublicPoll } from '../services/PollService';
import { BetaWhitelistService } from '../services/BetaWhitelistService';
import { addOrVoteWriteIn, listVisibleOptions, listAllOptions, setOptionHidden } from '../services/PollOptionsService';
import { anonTag } from '../services/anon/AnonTag';
import { openWave } from '../services/WaveService';
import { coerceTalliedAudience, resolveStickyAudience } from '../services/AudienceService';
import { isAccountId } from '../services/accounts/AccountService';
import type { PollSubmission } from '../../src/lib/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

const POLL_ID_RE = /^\/api\/polls\/([a-zA-Z0-9_-]+)$/;
const POLL_ELIGIBILITY_RE = /^\/api\/polls\/([a-zA-Z0-9_-]+)\/eligibility$/;
const POLL_AGGREGATE_RE = /^\/api\/polls\/([a-zA-Z0-9_-]+)\/aggregate$/;
const POLL_OPTIONS_RE = /^\/api\/polls\/([a-zA-Z0-9_-]+)\/options$/;
const POLL_OPTIONS_ALL_RE = /^\/api\/polls\/([a-zA-Z0-9_-]+)\/options\/all$/;
const POLL_OPTION_MOD_RE = /^\/api\/polls\/([a-zA-Z0-9_-]+)\/options\/([a-zA-Z0-9_-]+)$/;

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
    if (!auth.authenticated || auth.userKey === undefined) {
      return new Response(auth.error || 'Unauthorized', { status: 401 });
    }
    // The profile row: refreshed from Farcaster when the account has a fid;
    // an account without one already has its row (createAccount writes it).
    if (auth.fid && !(await ensureUserExists(env, auth.fid))) {
      return new Response('Failed to create/retrieve user', { status: 500 });
    }

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
      author_fid: auth.userKey, // polls.author_fid is a person key
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

  // GET /api/polls/:id/aggregate — the wave's tally (latest per (wave, user)),
  // for /poll/:id/results and its OG chart. Public/Anon only.
  const aggregateMatch = url.pathname.match(POLL_AGGREGATE_RE);
  if (aggregateMatch && request.method === 'GET') {
    const allowed = await rateLimitService.checkLimit(ip, 120, 60, 'polls:aggregate');
    if (!allowed) return new Response('Too Many Requests', { status: 429 });
    try {
      const { getPollAggregateResults } = await import('../services/AggregateResultsService');
      const data = await getPollAggregateResults(env.DB, aggregateMatch[1]);
      if (!data) return Response.json({ error: 'poll not found' }, { status: 404 });
      return Response.json(data, { headers: { 'Cache-Control': 'public, max-age=60' } });
    } catch (error) {
      console.error('[Poll Aggregate] Error:', error);
      return Response.json({ error: 'Failed to fetch poll results' }, { status: 500 });
    }
  }

  // ── Open-options waves (write-in MC) ─────────────────────────────────────

  // GET /api/polls/:id/options — visible options, in declared order. Public;
  // created_by_fid is never returned.
  const optionsMatch = url.pathname.match(POLL_OPTIONS_RE);
  if (optionsMatch && request.method === 'GET') {
    const allowed = await rateLimitService.checkLimit(ip, 120, 60, 'polls:options-list');
    if (!allowed) return new Response('Too Many Requests', { status: 429 });
    const poll = await getPoll(env.DB, optionsMatch[1]);
    if (!poll) return Response.json({ error: 'poll not found' }, { status: 404 });
    const options = await listVisibleOptions(env.DB, poll.id);
    return Response.json({ options }, { headers: { 'Cache-Control': 'public, max-age=10' } });
  }

  // POST /api/polls/:id/options — add a write-in option (or merge into an
  // existing one) AND record the submitter's vote through this wave. Auth
  // required; the wave's gate is enforced exactly like answers/create.ts.
  if (optionsMatch && request.method === 'POST') {
    const allowed = await rateLimitService.checkLimit(ip, 5, 60, 'polls:writein');
    if (!allowed) {
      return Response.json({ error: 'Too many write-ins. Please wait a moment.' }, { status: 429 });
    }
    const auth = await requireFlexibleAuth(request, env);
    if (!auth.authenticated || auth.userKey === undefined) {
      return new Response(auth.error || 'Unauthorized', { status: 401 });
    }
    const userKey = auth.userKey;
    const poll = await getPoll(env.DB, optionsMatch[1]);
    if (!poll) return Response.json({ error: 'poll not found' }, { status: 404 });
    let body: { label?: unknown; audience?: unknown };
    try { body = await request.json() as { label?: unknown; audience?: unknown }; } catch { return Response.json({ error: 'Invalid JSON' }, { status: 400 }); }
    const label = typeof body?.label === 'string' ? body.label : '';
    // Gates are Farcaster/wallet facts: checked by the linked fid.
    const elig = await EligibilityService.check(env, poll, auth.fid);
    if (!elig.eligible) {
      if (elig.reason === 'closed') {
        return Response.json(
          { error: 'Voting has closed for this poll', code: 'poll_closed', closes_at: elig.closesAt },
          { status: 423 },
        );
      }
      if (!auth.fid) {
        return Response.json({ error: 'farcaster_required' }, { status: 409 });
      }
      return Response.json({ error: 'You are not eligible to answer this poll', code: 'not_eligible' }, { status: 403 });
    }
    if (auth.fid && !(await ensureUserExists(env, auth.fid))) {
      return new Response('Failed to create/retrieve user', { status: 500 });
    }
    // The write-in records a vote: same audience rules as any answer (sticky per wave).
    // Answers.user_id, the anon tag and poll_options.created_by_fid are person keys.
    // TODO(account-root): between the cutover and the retag sweep a sticky Anon row is
    // tagged over the legacy key; resolveStickyAudience takes one tag (AnonAttributionService.authorTags has both).
    const sticky = await resolveStickyAudience(env.DB, poll.question_id, userKey, poll.id, coerceTalliedAudience(body?.audience), await anonTag(env, userKey, poll.question_id));
    const result = await addOrVoteWriteIn(env, poll, userKey, label, sticky.audience);
    if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
    return Response.json({ option: result.option, merged: result.merged, audience: sticky.audience, audience_kept: sticky.sticky && sticky.audience !== coerceTalliedAudience(body?.audience) });
  }

  // GET /api/polls/:id/options/all — all options incl. hidden (creator/admin).
  const optionsAllMatch = url.pathname.match(POLL_OPTIONS_ALL_RE);
  if (optionsAllMatch && request.method === 'GET') {
    const auth = await requireFlexibleAuth(request, env);
    if (!auth.authenticated || auth.userKey === undefined) {
      return new Response(auth.error || 'Unauthorized', { status: 401 });
    }
    const poll = await getPoll(env.DB, optionsAllMatch[1]);
    if (!poll) return Response.json({ error: 'poll not found' }, { status: 404 });
    if (!(await canModerate(env, poll, auth))) return new Response('Forbidden', { status: 403 });
    const options = await listAllOptions(env.DB, poll.id);
    return Response.json({ options });
  }

  // PATCH /api/polls/:id/options/:oid — hide/unhide an option (moderation).
  // Gated to the wave's author, the question's creator, or an admin.
  const optionModMatch = url.pathname.match(POLL_OPTION_MOD_RE);
  if (optionModMatch && request.method === 'PATCH') {
    const auth = await requireFlexibleAuth(request, env);
    if (!auth.authenticated || auth.userKey === undefined) {
      return new Response(auth.error || 'Unauthorized', { status: 401 });
    }
    const poll = await getPoll(env.DB, optionModMatch[1]);
    if (!poll) return Response.json({ error: 'poll not found' }, { status: 404 });
    if (!(await canModerate(env, poll, auth))) return new Response('Forbidden', { status: 403 });
    let body: { hidden?: unknown };
    try { body = await request.json() as { hidden?: unknown }; } catch { body = {}; }
    const hidden = body?.hidden !== false; // default → hide
    const ok = await setOptionHidden(env.DB, poll.id, optionModMatch[2], hidden);
    if (!ok) return Response.json({ error: 'option not found' }, { status: 404 });
    return Response.json({ ok: true, hidden });
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

/**
 * Wave author, question creator, or admin may moderate a wave's options.
 * `polls.author_fid` is a person key (compared with userKey); the admin list
 * and `queries.coiner_fid` are Farcaster facts (compared with the linked fid).
 * `queries.coiner_id` is compared only for a real account id: before the
 * cutover it holds a mix of legacy internal ids and fids (anon_id 3 is also
 * FID 3), so matching it against a fid would be unsafe.
 */
async function canModerate(env: Env, poll: { author_fid: number | null; question_id: string }, auth: AuthResult): Promise<boolean> {
  if (auth.fid && BetaWhitelistService.isAdmin(auth.fid)) return true;
  if (poll.author_fid != null && auth.userKey !== undefined && Number(poll.author_fid) === Number(auth.userKey)) return true;
  const q = await env.DB.prepare('SELECT coiner_fid, coiner_id FROM queries WHERE id = ?').bind(poll.question_id).first() as { coiner_fid: number | null; coiner_id: number | null } | null;
  if (!q) return false;
  if (auth.fid && q.coiner_fid != null && Number(q.coiner_fid) === Number(auth.fid)) return true;
  return isAccountId(auth.userKey) && Number(q.coiner_id) === auth.userKey;
}
