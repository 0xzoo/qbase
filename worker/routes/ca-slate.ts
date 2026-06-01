/**
 * ca-slate — snap route handler + web API.
 *
 * Mounted at /snap/ca-slate by worker/routes/snap.ts.
 * Web API at /api/ca-slate/* (same handler).
 *
 * State machine:
 *   GET  /snap/ca-slate                    → intro
 *   GET  /snap/ca-slate?share              → share card
 *   GET  /snap/ca-slate?sid=SID            → re-render current scene
 *   POST /snap/ca-slate?start=1            → create session, return Q0 (party)
 *   POST /snap/ca-slate?sid=SID            → record answer, return next scene
 *   POST /snap/ca-slate?sid=SID&choice=…   → record Q0 party choice
 *
 *   GET  /api/ca-slate/web/state[?sid=X]   → sanitized Q0 + Q1..Q13 + in-flight
 *   POST /api/ca-slate/web/start           → create/resume session (auth'd)
 *   POST /api/ca-slate/web/answer          → record answer, return next state
 *   GET  /api/ca-slate/session?sid=X       → session + computed result
 *
 * No airdrop, no $QQ gate, no LLM narratives — pure algorithmic result.
 * Mirrors the values pattern (single file holds both snap + web API) minus
 * the airdrop layer.
 */

import { parseSnapRequestCompat } from '../services/snapCompat';
import { AuthService } from '../services/AuthService';
import { requireFlexibleAuth } from '../middleware/auth';
import {
  CA_SLATE_LENGTH,
  CA_SLATE_TOTAL,
  PARTY_QUESTION,
  caSlateQuestions,
} from '../services/ca-slate/questions';
import {
  LIKERT_SCORES,
  scoreCaSlate,
  type CaSlateAnswer,
  type PartyChoice,
} from '../services/ca-slate/scoring';
import {
  SNAP_CONTENT_TYPE,
  introSnap,
  likertQuestionSnap,
  partyQuestionSnap,
  resultSnap,
  shareSnap,
} from '../services/ca-slate/snap';
import {
  loadSession,
  loadSessionForFid,
  newSession,
  newSessionId,
  saveFidIndex,
  saveSession,
  type CaSlateSession,
} from '../services/ca-slate/session';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

export const CA_SLATE_PATH = '/snap/ca-slate';
// Dev alias — same handler, different path, used to iterate without fighting
// Farcaster's snap embed cache.
export const CA_SLATE_DEV_PATH = '/snap/ca-slate-dev';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, X-Snap-Payload',
  'Access-Control-Max-Age': '86400',
};

function snapJson(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: {
      'Content-Type': SNAP_CONTENT_TYPE,
      'Cache-Control': 'private, max-age=0',
      'Vary': 'Accept, X-Snap-Payload',
      ...CORS_HEADERS,
      ...(init.headers || {}),
    },
  });
}

function miniappOrigin(env: Env, reqOrigin: string): string {
  // Per-snap miniapp origin override env (e.g. for staging). Falls back to
  // the request origin so the same code works in dev and prod.
  return (env.CA_SLATE_MINIAPP_ORIGIN as string | undefined) || reqOrigin;
}

const VALID_PARTY: ReadonlySet<PartyChoice> = new Set(['dem', 'rep', 'any']);

// ─── Snap entry point ──────────────────────────────────────────────────────

export async function handleCaSlateSnap(
  request: Request,
  env: Env
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path !== CA_SLATE_PATH && path !== CA_SLATE_DEV_PATH) return null;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // HEAD probe — see values.ts for the why.
  if (request.method === 'HEAD') {
    return new Response(null, {
      status: 200,
      headers: {
        'Content-Type': SNAP_CONTENT_TYPE,
        'Cache-Control': 'private, max-age=0',
        'Vary': 'Accept, X-Snap-Payload',
        ...CORS_HEADERS,
      },
    });
  }

  let parsed;
  try {
    parsed = await parseSnapRequestCompat(request, env);
  } catch (e) {
    console.error('[ca-slate] parseRequestCompat threw:', e);
    return Response.json({ error: 'parse failure' }, { status: 400 });
  }
  if (!parsed.success) {
    console.warn('[ca-slate] parseRequest failed:', parsed.error);
    return Response.json({ error: parsed.error }, { status: 400 });
  }

  const origin = url.origin;
  const mOrigin = miniappOrigin(env, origin);
  const sidParam = url.searchParams.get('sid');
  const isStart = url.searchParams.get('start') === '1';

  // ─── GET paths ────────────────────────────────────────────────────────
  if (parsed.action.type === 'get') {
    if (url.searchParams.has('share')) {
      // Personalized share (sid provided) re-renders the result snap; bare
      // share (no sid) shows the generic share card.
      if (sidParam) {
        const session = await loadSession(env, sidParam);
        if (session && session.index >= CA_SLATE_TOTAL) {
          return snapJson(
            resultSnap(session.id, scoreCaSlate(session.answers), origin, mOrigin)
          );
        }
      }
      return snapJson(shareSnap(origin));
    }
    if (sidParam) {
      const session = await loadSession(env, sidParam);
      if (session) return renderSessionScene(session, origin, mOrigin);
    }
    // Auto-resume from viewer FID
    const viewerFid = (parsed.action as { user?: { fid?: number } }).user?.fid;
    if (typeof viewerFid === 'number') {
      const session = await loadSessionForFid(env, viewerFid);
      if (session) return renderSessionScene(session, origin, mOrigin);
    }
    return snapJson(introSnap(origin));
  }

  const post = parsed.action;

  // ─── POST: start ─────────────────────────────────────────────────────
  if (isStart) {
    const fid = post.user.fid;
    // If FID has a completed session, jump to result.
    const prior = await loadSessionForFid(env, fid);
    if (prior && prior.index >= CA_SLATE_TOTAL) {
      return renderSessionScene(prior, origin, mOrigin);
    }
    const sid = newSessionId();
    const session = newSession(sid, fid);
    await saveSession(env, session);
    return snapJson(partyQuestionSnap(sid, origin));
  }

  // ─── POST: answer ───────────────────────────────────────────────────
  if (!sidParam) {
    return snapJson(introSnap(origin));
  }
  const session = await loadSession(env, sidParam);
  if (!session) {
    return snapJson(introSnap(origin));
  }
  if (session.fid !== post.user.fid) {
    console.warn(
      `[ca-slate] FID mismatch on sid=${sidParam}: session=${session.fid} post=${post.user.fid}`
    );
    return snapJson(introSnap(origin));
  }
  if (session.index >= CA_SLATE_TOTAL) {
    return renderSessionScene(session, origin, mOrigin);
  }

  // Two answer shapes:
  //   index 0 → Q0 party (choice in URL, like bartlet/values forced-choice)
  //   index 1..13 → Likert slider (value 1..5 in inputs)
  const nextAnswer = parseAnswer(session.index, post.inputs, url);
  if (!nextAnswer) {
    // Re-render the same scene on bad input.
    return snapJson(renderSceneForIndex(session, origin));
  }

  session.answers.push(nextAnswer);
  if (nextAnswer.type === 'party') {
    session.party = nextAnswer.choice;
  }
  session.index += 1;

  if (session.index < CA_SLATE_TOTAL) {
    await saveSession(env, session);
    return snapJson(renderSceneForIndex(session, origin));
  }

  // Done — persist fid index for revisit resume.
  await saveFidIndex(env, session.fid, session.id);
  await saveSession(env, session);
  return snapJson(
    resultSnap(session.id, scoreCaSlate(session.answers), origin, mOrigin)
  );
}

// ─── Scene routing ────────────────────────────────────────────────────────

function renderSceneForIndex(session: CaSlateSession, origin: string) {
  if (session.index === 0) return partyQuestionSnap(session.id, origin);
  const likertIdx = session.index - 1;
  return likertQuestionSnap(session.id, likertIdx, origin);
}

function renderSessionScene(
  session: CaSlateSession,
  origin: string,
  mOrigin: string
): Response {
  if (session.index >= CA_SLATE_TOTAL) {
    return snapJson(
      resultSnap(session.id, scoreCaSlate(session.answers), origin, mOrigin)
    );
  }
  return snapJson(renderSceneForIndex(session, origin));
}

// ─── Answer parsing ──────────────────────────────────────────────────────

function parseAnswer(
  index: number,
  inputs: Record<string, unknown>,
  url: URL
): CaSlateAnswer | null {
  if (index === 0) {
    // Q0 party. choice is in URL (?choice=democratic primary) — label form.
    const fromUrl = url.searchParams.get('choice');
    const fromInputs = typeof inputs.choice === 'string' ? inputs.choice : null;
    const raw = fromUrl ?? fromInputs;
    if (!raw) return null;
    const opt = PARTY_QUESTION.options.find(
      (o) => o.label === raw || o.choice === raw
    );
    if (!opt) return null;
    if (!VALID_PARTY.has(opt.choice)) return null;
    return { questionId: 'q0_party', type: 'party', choice: opt.choice };
  }

  // Likert for index 1..13. The 0-based Likert index is index-1.
  const likertIdx = index - 1;
  if (likertIdx < 0 || likertIdx >= CA_SLATE_LENGTH) return null;
  const q = caSlateQuestions[likertIdx];
  if (!q || q.type !== 'likert') return null;

  // URL-encoded likert value (button-tap flow): ?value=1..5
  const fromUrl = url.searchParams.get('value');
  const fromInputs = inputs.value;
  const raw = fromUrl ?? fromInputs;
  const num = Number(raw);
  if (!Number.isFinite(num)) return null;
  const clamped = Math.max(1, Math.min(5, Math.round(num)));
  const position = clamped - 1;
  if (LIKERT_SCORES[position] === undefined) return null;
  return { questionId: q.id, type: 'likert', position };
}

// ─── Web API ────────────────────────────────────────────────────────────

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

export async function handleCaSlateApi(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: API_CORS_HEADERS });
  }

  // ─── GET /api/ca-slate/session?sid=X ─────────────────────────────────
  // Used by /ca-slate/result mini-app page.
  if (path === '/api/ca-slate/session' && method === 'GET') {
    const sid = url.searchParams.get('sid');
    if (!sid) return jsonResponse({ error: 'Missing sid' }, 400);
    const auth = await authenticateFid(request, env);
    if (auth instanceof Response) return auth;
    const session = await loadSession(env, sid);
    if (!session) return jsonResponse({ error: 'Not found' }, 404);
    if (session.fid !== auth.fid) {
      return jsonResponse({ error: 'Forbidden' }, 403);
    }
    const completed = session.index >= CA_SLATE_TOTAL;
    const result = completed ? scoreCaSlate(session.answers) : null;
    return jsonResponse({
      session: {
        id: session.id,
        fid: session.fid,
        index: session.index,
        total: CA_SLATE_TOTAL,
        completed,
        createdAt: session.createdAt,
      },
      result,
    });
  }

  // ─── GET /api/ca-slate/web/state?fid=X&sid=X ────────────────────────
  // Returns the question bank + current session state. Used by QuizPage.
  // Shape mirrors the trinity (apperception/values/bartlet) so the generic
  // QuizPage can render it without a per-quiz fork: a flat `questions`
  // array with a 'forced' first entry for Q0 (party filter) and 13 'likert'
  // entries for the policy dims.
  if (path === '/api/ca-slate/web/state' && method === 'GET') {
    const auth = await authenticateFid(request, env);
    if (auth instanceof Response) return auth;

    // Prefer the explicit ?sid= from localStorage so a reload resumes.
    // Fall back to the FID index.
    const sidParam = url.searchParams.get('sid');
    let session: CaSlateSession | null = null;
    if (sidParam) {
      session = await loadSession(env, sidParam);
      if (session && session.fid !== auth.fid) session = null;
    }
    if (!session) session = await loadSessionForFid(env, auth.fid);

    // Flat question array. Q0 first as a forced-choice, then 13 Likerts.
    const questions = [
      {
        id: PARTY_QUESTION.id,
        stem: PARTY_QUESTION.stem,
        type: 'forced' as const,
        a_options: PARTY_QUESTION.options.map((o) => ({ label: o.label })),
      },
      ...caSlateQuestions.map((q) => ({
        id: q.id,
        stem: q.stem,
        type: 'likert' as const,
      })),
    ];

    return jsonResponse({
      questions,
      total: CA_SLATE_TOTAL,
      questionCount: CA_SLATE_LENGTH,
      session: session
        ? {
            id: session.id,
            index: session.index,
            total: CA_SLATE_TOTAL,
            answers: session.answers,
            party: session.party ?? null,
            completed: session.index >= CA_SLATE_TOTAL,
          }
        : null,
    });
  }

  // ─── POST /api/ca-slate/web/start ────────────────────────────────────
  if (path === '/api/ca-slate/web/start' && method === 'POST') {
    const auth = await authenticateFid(request, env);
    if (auth instanceof Response) return auth;

    // Resume if there's a prior in-flight session.
    const prior = await loadSessionForFid(env, auth.fid);
    if (prior && prior.index < CA_SLATE_TOTAL) {
      return jsonResponse({
        session: {
          id: prior.id,
          index: prior.index,
          answers: prior.answers,
          party: prior.party ?? null,
        },
      });
    }
    // If prior is complete, signal that the client should jump to /ca-slate/result.
    if (prior && prior.index >= CA_SLATE_TOTAL) {
      return jsonResponse({
        session: { id: prior.id, index: prior.index, completed: true },
      });
    }

    const sid = newSessionId();
    const session = newSession(sid, auth.fid);
    await saveSession(env, session);
    return jsonResponse({
      session: {
        id: session.id,
        index: session.index,
        answers: session.answers,
        party: null,
      },
    });
  }

  // ─── POST /api/ca-slate/web/answer ───────────────────────────────────
  if (path === '/api/ca-slate/web/answer' && method === 'POST') {
    const auth = await authenticateFid(request, env);
    if (auth instanceof Response) return auth;

    // The generic QuizPage submits forced-choice as {optionIndex: N} and
    // Likert as {position: N} (see QuizPage.tsx). Snap clients send
    // {choice: '...'} (URL-encoded label) or {value: N} (slider). The
    // handler accepts both shapes for back-compat.
    let body: {
      sid?: string;
      choice?: string;
      value?: number | string;
      position?: number;
      optionIndex?: number;
    };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return jsonResponse({ error: 'Bad JSON' }, 400);
    }
    if (!body.sid) {
      return jsonResponse({ error: 'Missing sid' }, 400);
    }
    const session = await loadSession(env, body.sid);
    if (!session) return jsonResponse({ error: 'Session not found' }, 404);
    if (session.fid !== auth.fid) {
      return jsonResponse({ error: 'Forbidden' }, 403);
    }
    if (session.index >= CA_SLATE_TOTAL) {
      return jsonResponse({
        session: { id: session.id, index: session.index, completed: true },
      });
    }

    const expectedId =
      session.index === 0 ? 'q0_party' : caSlateQuestions[session.index - 1]?.id;
    const isPartyStep = session.index === 0;

    // Build the canonical CaSlateAnswer from the request.
    let nextAnswer: CaSlateAnswer | null = null;
    if (isPartyStep) {
      // Accept either a choice string ('dem' | 'rep' | 'any' or the label form)
      // or an optionIndex into PARTY_QUESTION.options.
      let choice: PartyChoice | null = null;
      if (typeof body.choice === 'string' && VALID_PARTY.has(body.choice as PartyChoice)) {
        choice = body.choice as PartyChoice;
      } else if (typeof body.choice === 'string') {
        const opt = PARTY_QUESTION.options.find((o) => o.label === body.choice);
        if (opt) choice = opt.choice;
      }
      if (!choice && typeof body.optionIndex === 'number') {
        const opt = PARTY_QUESTION.options[body.optionIndex];
        if (opt && VALID_PARTY.has(opt.choice)) choice = opt.choice;
      }
      if (!choice) return jsonResponse({ error: 'Missing or invalid party choice' }, 400);
      nextAnswer = { questionId: 'q0_party', type: 'party', choice };
    } else {
      // Likert: accept position (0..4) or value (1..5) or URL-style ?value.
      const likertIdx = session.index - 1;
      const q = caSlateQuestions[likertIdx];
      if (!q || q.type !== 'likert') return jsonResponse({ error: 'Bad index' }, 400);
      let position: number | null = null;
      if (typeof body.position === 'number') position = body.position;
      else if (typeof body.value === 'number') position = Math.round(body.value) - 1;
      else if (typeof body.value === 'string' && body.value) {
        const n = Number(body.value);
        if (Number.isFinite(n)) position = Math.round(n) - 1;
      }
      if (position === null || position < 0 || position > 4) {
        return jsonResponse({ error: 'Missing or invalid likert position' }, 400);
      }
      if (LIKERT_SCORES[position] === undefined) {
        return jsonResponse({ error: 'Bad likert position' }, 400);
      }
      nextAnswer = { questionId: q.id, type: 'likert', position };
    }

    if (nextAnswer.questionId !== expectedId) {
      return jsonResponse(
        { error: `Expected answer for ${expectedId}, got ${nextAnswer.questionId}` },
        400
      );
    }

    session.answers.push(nextAnswer);
    if (nextAnswer.type === 'party') {
      session.party = nextAnswer.choice;
    }
    session.index += 1;

    if (session.index >= CA_SLATE_TOTAL) {
      await saveFidIndex(env, session.fid, session.id);
    }
    await saveSession(env, session);

    return jsonResponse({
      session: {
        id: session.id,
        index: session.index,
        total: CA_SLATE_TOTAL,
        completed: session.index >= CA_SLATE_TOTAL,
        answers: session.answers,
        party: session.party ?? null,
      },
      result: session.index >= CA_SLATE_TOTAL
        ? scoreCaSlate(session.answers)
        : null,
    });
  }

  return jsonResponse({ error: 'Not found' }, 404);
}

// Use requireFlexibleAuth to keep the surface aligned with values/apperception
// web API — but the bearer-token path is the one we actually wire (Quick
// Auth). requireFlexibleAuth is exported for future SIWF support.
export { requireFlexibleAuth };
