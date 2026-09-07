/**
 * Council API routes (docs/specs/paid-council.md)
 *
 * - GET  /api/council/config          — price, gate state, escrow + $QQ addresses
 * - GET  /api/council/stake           — the caller's stake: balance, cooldown, summons left (auth)
 * - GET  /api/queries/:id/council     — the question's council thread + the viewer's ability to summon
 * - POST /api/queries/:id/council     — summon the council for the question (auth; 402 stake_required)
 *
 * Registered before the generic /api/queries handler in worker/index.ts.
 */

import { requireFlexibleAuth, getOptionalAuth } from '../middleware/auth';
import { RateLimitService } from '../services/RateLimitService';
import { OracleEscrowService } from '../services/OracleEscrowService';
import { councilConfig, listResponses, publicCouncilConfig, summon, viewerStake } from '../services/CouncilService';

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
    if (!auth.authenticated || !auth.fid) return new Response(auth.error || 'Unauthorized', { status: 401 });

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
    const responses = await listResponses(env, questionId);
    const viewerFid = await getOptionalAuth(request, env);
    const viewer = viewerFid ? { fid: viewerFid, ...(await viewerStake(env, viewerFid)) } : null;
    return Response.json({ config: publicCouncilConfig(env), responses, viewer });
  }

  if (m && request.method === 'POST') {
    const allowed = await rateLimitService.checkLimit(ip, 10, 60, 'council:summon:ip');
    if (!allowed) return new Response('Too Many Requests', { status: 429 });

    const auth = await requireFlexibleAuth(request, env);
    if (!auth.authenticated || !auth.fid) return new Response(auth.error || 'Unauthorized', { status: 401 });

    const result = await summon(env, {
      questionId: m[1],
      fid: auth.fid,
      username: auth.user?.username,
      source: 'web',
    });

    if (result.ok) {
      return Response.json({ status: result.status, summon_id: result.summonId, price: result.price, responses: result.responses });
    }
    const status = {
      question_not_found: 404,
      no_question_text: 400,
      in_flight: 409,
      rate_limited: 429,
      escrow_unconfigured: 503,
      dispatch_failed: 502,
      stake_required: 402,
    }[result.code];
    return Response.json({ error: result.message, ...result }, { status });
  }

  return null;
}
