/**
 * apperception — mini-app API endpoints.
 *
 * GET  /api/apperception/session?sid=X   — session + scores + gate state
 * GET  /api/apperception/shape/v{N}/{sid}.png — public radar PNG (R2-cached)
 * POST /api/apperception/rate?sid=X      — record thumbs up/down
 *
 * Web quiz endpoints (browser flow at /quiz/apperception):
 * GET  /api/apperception/web/state       — sanitized questions + in-flight session (if any)
 * POST /api/apperception/web/start       — create (or resume) a session for the auth'd FID
 * POST /api/apperception/web/answer      — record one answer, return next state
 *
 * Auth: Bearer token via Quick Auth (same as values API).
 * Web endpoints accept either Quick Auth JWT (MiniApp) or SIWF session token
 * (web sign-in) via requireFlexibleAuth.
 */

import {
  loadSession,
  loadSessionForFid,
  newSession,
  newSessionId,
  saveFidIndex,
  saveSession,
} from '../services/apperception/session';
import {
  freeTierResult,
  gatedTierResult,
  type ApperceptionAnswer,
  type ApperceptionFreeTierResult,
  type ApperceptionGatedTierResult,
} from '../services/apperception/scoring';
import {
  APPERCEPTION_LENGTH,
  apperceptionQuestions,
} from '../services/apperception/questions';
import { checkQQGateApperception, type QQGateState } from '../services/apperception/gate';
import { runApperceptionAirdrop } from '../services/apperception/airdrop';
import {
  hasApperceptionCompletion,
  writeApperceptionCompletion,
} from '../services/apperception/completion';
import { renderShapePng } from '../services/apperception/shapeImage';
import { getCachedNeynarUser } from '../services/NeynarUserService';
import { AuthService } from '../services/AuthService';
import { requireFlexibleAuth } from '../middleware/auth';

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

      // Personalize the badge with the taker's @username (KV-cached Neynar
      // lookup). Best-effort: a miss just renders the bare badge.
      const neynarUser = await getCachedNeynarUser(env, session.fid);

      let pngBytes: Uint8Array;
      try {
        pngBytes = await renderShapePng(env, result.scores, {
          badge: result.style.style,
          user: neynarUser?.username,
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

    // Airdrop retry (for sessions where the airdrop didn't send on the first
    // pass — e.g. completed before the airdrop was enabled, or a transient RPC
    // error). On success, persist back to the session so the in-feed result snap
    // reflects it and we stop re-running the pipeline on every result-page load.
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
        if (outcome.kind === 'success' || outcome.kind === 'already_claimed') {
          session.airdropped = true;
          session.airdropTxHash = outcome.txHash;
          session.airdropStatus = outcome.kind;
          if ('amountTokens' in outcome) session.airdropAmountTokens = outcome.amountTokens;
          await saveSession(env, session);
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

  // ── Web quiz endpoints (browser flow) ────────────────────────────────

  // GET /api/apperception/web/state[?sid=X] — sanitized questions + session.
  // With sid: load that specific session (FID must match) — used by clients
  //          to resume an in-flight session via localStorage-persisted sid.
  // Without sid: fall back to the FID index, which only finds completed
  //          sessions — gives the client a fast "you already took it" path
  //          so it can redirect straight to /apperception/result.
  if (url.pathname === '/api/apperception/web/state' && request.method === 'GET') {
    const auth = await requireFlexibleAuth(request, env);
    if (!auth.authenticated || !auth.fid) {
      return jsonResponse({ error: auth.error || 'Unauthorized' }, 401);
    }
    const sidParam = url.searchParams.get('sid');
    let session = sidParam ? await loadSession(env, sidParam) : null;
    if (session && session.fid !== auth.fid) session = null;
    if (!session) session = await loadSessionForFid(env, auth.fid);
    return jsonResponse({
      total: APPERCEPTION_LENGTH,
      questions: webQuestions(),
      session: session ? sessionSummary(session) : null,
    });
  }

  // POST /api/apperception/web/start — create (or resume) a session
  if (url.pathname === '/api/apperception/web/start' && request.method === 'POST') {
    const auth = await requireFlexibleAuth(request, env);
    if (!auth.authenticated || !auth.fid) {
      return jsonResponse({ error: auth.error || 'Unauthorized' }, 401);
    }
    const existing = await loadSessionForFid(env, auth.fid);
    if (existing) {
      // Mid-quiz: resume in place. Completed: just hand the sid back so the
      // client can navigate to /apperception/result?sid=…
      return jsonResponse(sessionSummary(existing));
    }
    // New session. We deliberately don't call saveFidIndex here — the FID
    // index is reserved for completed sessions (so revisits short-circuit
    // to the result). Resume across reloads is handled client-side via a
    // localStorage-persisted sid passed back as ?sid=… on /web/state.
    const sid = newSessionId();
    const session = newSession(sid, auth.fid);
    await saveSession(env, session);
    return jsonResponse(sessionSummary(session));
  }

  // POST /api/apperception/web/answer — record one answer
  if (url.pathname === '/api/apperception/web/answer' && request.method === 'POST') {
    const auth = await requireFlexibleAuth(request, env);
    if (!auth.authenticated || !auth.fid) {
      return jsonResponse({ error: auth.error || 'Unauthorized' }, 401);
    }

    let body: { sid?: string; position?: number; optionIndex?: number };
    try {
      body = await request.json() as typeof body;
    } catch {
      return jsonResponse({ error: 'Invalid JSON body' }, 400);
    }
    if (!body.sid) return jsonResponse({ error: 'sid required' }, 400);

    const session = await loadSession(env, body.sid);
    if (!session) return jsonResponse({ error: 'session not found' }, 404);
    if (session.fid !== auth.fid) {
      return jsonResponse({ error: 'wrong fid' }, 403);
    }
    if (session.index >= APPERCEPTION_LENGTH) {
      return jsonResponse(sessionSummary(session));
    }

    const q = apperceptionQuestions[session.index];
    if (!q) return jsonResponse({ error: 'invalid index' }, 400);

    let answer: ApperceptionAnswer | null = null;
    if (q.type === 'likert') {
      const pos = body.position;
      if (typeof pos === 'number' && pos >= 0 && pos <= 4 && Number.isInteger(pos)) {
        answer = { questionId: q.id, type: 'likert', position: pos };
      }
    } else {
      const oi = body.optionIndex;
      if (typeof oi === 'number' && (oi === 0 || oi === 1)) {
        answer = { questionId: q.id, type: 'forced', optionIndex: oi };
      }
    }
    if (!answer) return jsonResponse({ error: 'invalid answer' }, 400);

    session.answers.push(answer);
    session.index += 1;
    await saveSession(env, session);

    // On completion: index by FID and best-effort run the airdrop pipeline
    // so /apperception/result is ready to render with airdrop state hydrated.
    if (session.index >= APPERCEPTION_LENGTH) {
      await saveFidIndex(env, session.fid, session.id);
      // Persist a cross-quiz completion row (the /quizzes feed reads
      // quiz_completions). Dedup on (quiz_id, fid) so a re-take or a stray
      // replay doesn't double-insert.
      try {
        const already = await hasApperceptionCompletion(env, session.fid);
        if (!already) {
          await writeApperceptionCompletion(env, {
            fid: session.fid,
            answers: session.answers,
          });
        }
      } catch (e) {
        console.error('[apperception] writeApperceptionCompletion failed:', e);
      }
      try {
        await runApperceptionAirdrop({
          env,
          fid: session.fid,
          sid: session.id,
        });
      } catch (e) {
        console.error('[apperception] airdrop on web completion failed:', e);
      }
    }

    return jsonResponse(sessionSummary(session));
  }

  return null;
}

// ── Web quiz helpers ─────────────────────────────────────────────────────

interface WebQuestion {
  id: string;
  stem: string;
  type: 'likert' | 'forced';
  a_options?: { label: string }[];
}

function webQuestions(): WebQuestion[] {
  return apperceptionQuestions.map((q) => {
    if (q.type === 'likert') {
      return { id: q.id, stem: q.stem, type: 'likert' as const };
    }
    return {
      id: q.id,
      stem: q.stem,
      type: 'forced' as const,
      a_options: q.a_options.map((o) => ({ label: o.label })),
    };
  });
}

function sessionSummary(s: {
  id: string; fid: number; index: number; createdAt: number;
}): { sid: string; fid: number; index: number; total: number; completed: boolean; createdAt: number } {
  return {
    sid: s.id,
    fid: s.fid,
    index: s.index,
    total: APPERCEPTION_LENGTH,
    completed: s.index >= APPERCEPTION_LENGTH,
    createdAt: s.createdAt,
  };
}
