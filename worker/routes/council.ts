/**
 * Council API routes (docs/specs/paid-council.md)
 *
 * - GET  /api/council/config          — price, gate state, escrow + $QQ addresses
 * - GET  /api/council/stake           — the caller's stake: balance, cooldown, summons left (auth)
 * - GET  /api/queries/:id/council     — the question's council thread + `applies` (typology) + the viewer's ability to summon
 * - POST /api/queries/:id/council     — summon the council for the question (auth; 402 stake_required;
 *                                       body { again: true } asks for a new paid round when a thread exists)
 *
 * Registered before the generic /api/queries handler in worker/index.ts.
 */

import { requireFlexibleAuth, getOptionalAuth } from '../middleware/auth';
import { RateLimitService } from '../services/RateLimitService';
import { OracleEscrowService } from '../services/OracleEscrowService';
import { councilConfig, listResponses, loadQuestionForCouncil, publicCouncilConfig, summon, viewerStake } from '../services/CouncilService';
import { councilApplies } from '../../src/lib/council';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

const QUESTION_COUNCIL_RE = /^\/api\/queries\/([a-zA-Z0-9_-]+)\/council$/;

export async function handleCouncilRoutes(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const pathname = url.pathname;
  const isCouncilPath = pathname.startsWith('/api/council/') || QUESTION_COUNCIL_RE.test(pathname);
  if (!isCouncilPath) return null;

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const rateLimitService = RateLimitService.fromEnv(env);

  if (pathname === '/api/council/config' && request.method === 'GET') {
    return Response.json(publicCouncilConfig(env), { headers: { 'Cache-Control': 'public, max-age=60' } });
  }

  if (pathname === '/api/council/stake' && request.method === 'GET') {
    const auth = await requireFlexibleAuth(request, env);
    if (!auth.authenticated) return new Response(auth.error || 'Unauthorized', { status: 401 });
    // The stake lives in OracleEscrow, keyed by Farcaster fid on-chain.
    if (!auth.fid) return Response.json({ error: 'farcaster_required' }, { status: 409 });

    const cfg = councilConfig(env);
    const escrow = OracleEscrowService.fromEnv(env);
    if (!escrow) {
      return Response.json({ fid: auth.fid, price: cfg.price, gated: cfg.gated, escrow_address: null, balance: null, cooldown_remaining: null, summons_remaining: null });
    }
    try {
      const [balance, cooldown] = await Promise.all([
        escrow.availableBalance(auth.fid, { fresh: url.searchParams.get('fresh') === '1' }),
        escrow.cooldownRemaining(auth.fid),
      ]);
      const summonsRemaining = cfg.priceWei > 0n ? Number(balance / cfg.priceWei) : null;
      return Response.json({
        fid: auth.fid,
        price: cfg.price,
        gated: cfg.gated,
        escrow_address: escrow.contractAddress,
        balance: balance.toString(),
        cooldown_remaining: Number(cooldown),
        summons_remaining: summonsRemaining,
      });
    } catch (err) {
      console.error('[Council] stake read failed', err);
      return Response.json({ error: 'Could not read your stake right now' }, { status: 502 });
    }
  }

  const m = pathname.match(QUESTION_COUNCIL_RE);
  if (m && request.method === 'GET') {
    const questionId = m[1];
    const q = await loadQuestionForCouncil(env, questionId);
    if (!q) return Response.json({ error: 'Question not found' }, { status: 404 });
    const applies = councilApplies(q.taxonomy);
    const config = publicCouncilConfig(env);
    // No thread lookup and no viewer stake read for questions the council cannot answer.
    if (!applies) return Response.json({ config, applies: false, responses: [], viewer: null });
    const responses = await listResponses(env, questionId);
    const viewerFid = config.open ? await getOptionalAuth(request, env) : undefined;
    const viewer = viewerFid ? { fid: viewerFid, ...(await viewerStake(env, viewerFid)) } : null;
    return Response.json({ config, applies: true, responses, viewer });
  }

  if (m && request.method === 'POST') {
    const allowed = await rateLimitService.checkLimit(ip, 10, 60, 'council:summon:ip');
    if (!allowed) return new Response('Too Many Requests', { status: 429 });

    const auth = await requireFlexibleAuth(request, env);
    if (!auth.authenticated || auth.userKey === undefined) return new Response(auth.error || 'Unauthorized', { status: 401 });
    // A summon is paid from the fid-keyed escrow stake and answered as Farcaster casts.
    if (!auth.fid) return Response.json({ error: 'farcaster_required' }, { status: 409 });

    let again = false;
    try {
      const body = await request.json().catch(() => ({})) as { again?: boolean };
      again = body?.again === true;
    } catch { /* no body */ }

    const result = await summon(env, {
      questionId: m[1],
      fid: auth.fid,
      userKey: auth.userKey, // council_summons.fid (person key)
      username: auth.user?.username,
      source: 'web',
      again,
    });

    if (result.ok) {
      return Response.json({ status: result.status, summon_id: result.summonId, price: result.price, responses: result.responses });
    }
    const status = {
      question_not_found: 404,
      no_question_text: 400,
      council_not_open: 503,
      council_not_applicable: 400,
      in_flight: 409,
      rate_limited: 429,
      escrow_unconfigured: 503,
      dispatch_failed: 502,
      stake_required: 402,
      resummon_requires_payment: 409,
    }[result.code];
    return Response.json({ error: result.message, ...result }, { status });
  }

  return null;
}
