/**
 * apperception — mini-app API endpoints.
 *
 * GET  /api/apperception/session?sid=X   — session + scores + gate state
 * GET  /api/apperception/shape/v{N}/{sid}.png — public radar PNG (R2-cached)
 * POST /api/apperception/rate?sid=X      — record thumbs up/down
 *
 * Auth: Bearer token via Quick Auth (same as values API).
 */

import { loadSession } from '../services/apperception/session';
import {
  freeTierResult,
  gatedTierResult,
  type ApperceptionFreeTierResult,
  type ApperceptionGatedTierResult,
} from '../services/apperception/scoring';
import { APPERCEPTION_LENGTH } from '../services/apperception/questions';
import { checkQQGateApperception, type QQGateState } from '../services/apperception/gate';
import { runApperceptionAirdrop } from '../services/apperception/airdrop';
import { renderShapePng } from '../services/apperception/shapeImage';
import { AuthService } from '../services/AuthService';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

const API_CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

function jsonResponse(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: API_CORS_HEADERS });
}

async function authenticateFid(
  request: Request,
  env: Env
): Promise<{ fid: number } | Response> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return jsonResponse({ error: 'Missing Authorization header' }, 401);
  }
  const token = authHeader.split(' ')[1];
  const authService = AuthService.fromEnv(env, request.url);
  const result = await authService.verifyQuickAuthToken(token);
  if (!result.valid || !result.fid) {
    return jsonResponse({ error: 'Invalid token' }, 401);
  }
  return { fid: result.fid };
}

export async function handleApperceptionApi(
  request: Request,
  env: Env
): Promise<Response | null> {
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: API_CORS_HEADERS });
  }

  // GET /api/apperception/shape/v{N}/{sid}.png — public radar PNG
  {
    const m = url.pathname.match(
      /^\/api\/apperception\/shape\/(v\d+)\/([A-Za-z0-9_-]+)\.png$/,
    );
    if (m && request.method === 'GET') {
      const version = m[1];
      const sid = m[2];
      const r2Key = `apperception/shape/${version}/${sid}.png`;

      try {
        const cached = await env.R2.get(r2Key);
        if (cached) {
          return new Response(cached.body, {
            status: 200,
            headers: {
              'content-type': 'image/png',
              'cache-control': 'public, max-age=31536000, immutable',
              'etag': cached.httpEtag,
            },
          });
        }
      } catch (e) {
        console.error('[apperception shape] R2 get failed:', e);
      }

      const session = await loadSession(env, sid);
      if (!session) return new Response('Not found', { status: 404 });
      if (session.index < APPERCEPTION_LENGTH) {
        return new Response('Quiz not complete', { status: 400 });
      }

      const result = freeTierResult(session.answers);

      let pngBytes: Uint8Array;
      try {
        pngBytes = await renderShapePng(env, result.scores, {
          badge: result.style.style.replace('Leaning ', ''),
        });
      } catch (e) {
        console.error('[apperception shape] render failed:', e);
        return new Response('Render failed', { status: 500 });
      }

      try {
        await env.R2.put(r2Key, pngBytes, {
          httpMetadata: {
            contentType: 'image/png',
            cacheControl: 'public, max-age=31536000, immutable',
          },
        });
      } catch (e) {
        console.error('[apperception shape] R2 put failed (still returning PNG):', e);
      }

      return new Response(pngBytes, {
        status: 200,
        headers: {
          'content-type': 'image/png',
          'cache-control': 'public, max-age=31536000, immutable',
        },
      });
    }
  }

  // GET /api/apperception/session?sid=X
  if (url.pathname === '/api/apperception/session' && request.method === 'GET') {
    const sid = url.searchParams.get('sid');
    if (!sid) return jsonResponse({ error: 'sid required' }, 400);

    const auth = await authenticateFid(request, env);
    if ('fid' in auth === false) return auth;

    const { fid } = auth as { fid: number };
    const session = await loadSession(env, sid);
    if (!session) return jsonResponse({ error: 'session not found' }, 404);
    if (session.fid !== fid) return jsonResponse({ error: 'wrong fid' }, 403);

    const completed = session.index >= APPERCEPTION_LENGTH;

    let free: ApperceptionFreeTierResult | null = null;
    let gated: ApperceptionGatedTierResult | null = null;

    if (completed) {
      free = freeTierResult(session.answers);
      gated = gatedTierResult(session.answers);
    }

    // Gate check
    let gate: QQGateState | null = null;
    try {
      gate = await checkQQGateApperception(env, fid);
    } catch (e) {
      console.error('[apperception-api] gate check failed:', e);
      gate = null;
    }

    // Airdrop retry (for sessions where airdrop failed on first pass)
    let airdrop = session.airdropped
      ? { status: 'success' as const, txHash: session.airdropTxHash }
      : { status: 'pending' as const };
    if (completed && !session.airdropped) {
      try {
        const outcome = await runApperceptionAirdrop({
          env,
          fid: session.fid,
          sid: session.id,
        });
        if (outcome.kind === 'success') {
          airdrop = { status: 'success' as const, txHash: outcome.txHash };
        } else if (outcome.kind === 'already_claimed') {
          airdrop = { status: 'success' as const, txHash: outcome.txHash };
        }
      } catch { /* best-effort */ }
    }

    return jsonResponse({
      session: {
        id: session.id,
        fid: session.fid,
        index: session.index,
        total: APPERCEPTION_LENGTH,
        completed,
        createdAt: session.createdAt,
        rated: session.rated,
      },
      free,
      gated,
      gate: gate ?? { unlocked: true, balance: '0', threshold: '4420000000000', address: null },
      airdrop,
    });
  }

  // POST /api/apperception/rate?sid=X
  if (url.pathname === '/api/apperception/rate' && request.method === 'POST') {
    const sid = url.searchParams.get('sid');
    if (!sid) return jsonResponse({ error: 'sid required' }, 400);

    const auth = await authenticateFid(request, env);
    if ('fid' in auth === false) return auth;

    const { fid } = auth as { fid: number };
    const session = await loadSession(env, sid);
    if (!session) return jsonResponse({ error: 'session not found' }, 404);
    if (session.fid !== fid) return jsonResponse({ error: 'wrong fid' }, 403);

    let body: { rating?: 'up' | 'down' } = {};
    try { body = await request.json(); } catch { /* ok */ }

    if (body.rating === 'up' || body.rating === 'down') {
      console.log(`[apperception] rating: fid=${fid} sid=${sid} rating=${body.rating}`);
      // Future: persist to D1 for narrative quality monitoring
    }

    return jsonResponse({ ok: true });
  }

  return null;
}
