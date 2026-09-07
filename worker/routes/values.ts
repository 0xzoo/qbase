/**
 * values — snap route handler.
 *
 * Mounted at `/snap/values` by worker/routes/snap.ts.
 *
 * State machine:
 *   GET  /snap/values                            → intro
 *   GET  /snap/values?share=DIM                  → first-person share card
 *   GET  /snap/values?sid=SID                    → re-render whatever scene
 *                                                  the session is on (results
 *                                                  for completed sessions)
 *   POST /snap/values?start=1                    → create session, return q0
 *                                                  (if FID has a complete prior
 *                                                  session, jump to its result)
 *   POST /snap/values?sid=SID                    → record answer for current
 *                                                  question, return next q OR
 *                                                  result. Answer payload depends
 *                                                  on q.type:
 *                                                    likert → inputs.value (1-5)
 *                                                    forced → ?choice=LABEL on URL
 *                                                    open   → inputs.value (string)
 *
 * Session state lives in KV (VALUES_SESSIONS); answers in QStorage. The
 * gated result tier is checked at render time against live $QQ balance —
 * not stored in session. Mirror bartlet's route shape, minus airdrop.
 *
 * Compatibility (CONTENT-PLAN §7.5, worker/services/values/compareService.ts):
 *   GET /api/values/compare/me            → the caller's latest values completion
 *   GET /api/values/compare?a=ID[&b=ID]   → compare two completions; without
 *                                           `b` the signed-in caller's latest
 *                                           completion is the other side.
 */

import { parseSnapRequestCompat } from '../services/snapCompat';
import {
  SNAP_CONTENT_TYPE,
  introSnap,
  questionSnap,
  resultSnap,
  shareSnap,
  type AirdropStatus,
} from '../services/values/snap';
import {
  loadSession,
  loadSessionForFid,
  newSession,
  newSessionId,
  saveFidIndex,
  saveSession,
  type ValuesSession,
} from '../services/values/session';
import { LIKERT_ANSWER_WEIGHTS, VALUES_LENGTH, valuesQuestions, type ValuesAxis } from '../services/values/questions';
import { dimNarratives, freeTierResult, type ValuesAnswer, type ValuesScore } from '../services/values/scoring';
import { checkQQGate } from '../services/values/gate';
import { buildContextCardMarkdown } from '../services/values/contextCard';
import { classifyOpenText } from '../services/values/openTextClassifier';
import {
  DIM_NARRATIVES_VERSION,
  generateDimNarratives,
  type DimNarratives,
} from '../services/values/dimNarrativeGenerator';
import { renderShapePng } from '../services/values/shapeImage';
import { runValuesAirdrop, type AirdropOutcome } from '../services/values/airdrop';
import { createQuizCompletion, completionSummary } from './quiz-completions';
import { AuthService } from '../services/AuthService';
import { getOptionalAuth, requireFlexibleAuth } from '../middleware/auth';
import {
  cardForCompletion,
  compareCompletions,
  isCompletionId,
  latestValuesCompletion,
} from '../services/values/compareService';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

export const VALUES_PATH = '/snap/values';
// Dev alias — same handler, different path, used to iterate without fighting
// Farcaster's snap embed cache.
export const VALUES_DEV_PATH = '/snap/values-dev';

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
  return (env.VALUES_MINIAPP_ORIGIN as string | undefined) || reqOrigin;
}

const VALID_DIMS: readonly ValuesAxis[] = [
  'autonomy',
  'care',
  'openness',
  'mastery',
  'universalism',
];

function isValidDim(s: string): s is ValuesAxis {
  return (VALID_DIMS as readonly string[]).includes(s);
}

export async function handleValuesSnap(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // HEAD — some snap clients (e.g. Quorum) probe the embed with HEAD before
  // committing to the snap path. parseRequest below rejects a body-less HEAD
  // with 400, which the probe interprets as "not a snap" and falls back to a
  // plain URL preview, so the snap never renders.
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

  const parsed = await parseSnapRequestCompat(request, env);
  if (!parsed.success) {
    console.warn('[values] parseRequest failed:', parsed.error);
    return Response.json({ error: parsed.error }, { status: 400 });
  }

  const sidParam = url.searchParams.get('sid');
  const isStart = url.searchParams.get('start') === '1';

  // ─── GET paths ───────────────────────────────────────────────────────
  if (parsed.action.type === 'get') {
    const shareParam = url.searchParams.get('share');
    if (shareParam && isValidDim(shareParam)) {
      // Optional sid → personalized share with the sharer's radar PNG hero.
      // sid is taken from the URL as authoritative; we don't load the
      // session here because the dim already comes from the URL too, and
      // the PNG route enforces existence.
      const shareSid = url.searchParams.get('sid') || undefined;
      return snapJson(shareSnap(shareParam, url.origin, shareSid));
    }
    if (sidParam) {
      const session = await loadSession(env, sidParam);
      if (session) return renderSessionScene(session, url.origin, env);
    }
    // Snap GETs include the viewer's FID once they've interacted before. If
    // we have it and the FID has an in-flight (or completed) session, jump
    // straight to its current scene — auto-resume.
    const viewerFid = (parsed.action as { user?: { fid?: number } }).user?.fid;
    if (typeof viewerFid === 'number') {
      const session = await loadSessionForFid(env, viewerFid);
      if (session) return renderSessionScene(session, url.origin, env);
    }
    return snapJson(introSnap(url.origin));
  }

  const post = parsed.action; // narrowed to 'post'

  // ─── POST: start ─────────────────────────────────────────────────────
  if (isStart) {
    const fid = post.user.fid;
    // FID with a completed session → jump to result.
    const prior = await loadSessionForFid(env, fid);
    if (prior && prior.index >= VALUES_LENGTH) {
      return renderSessionScene(prior, url.origin, env);
    }
    const sid = newSessionId();
    const session = newSession(sid, fid);
    await saveSession(env, session);
    return snapJson(questionSnap(sid, 0, url.origin));
  }

  // ─── POST: answer ────────────────────────────────────────────────────
  if (!sidParam) {
    return snapJson(introSnap(url.origin));
  }

  const session = await loadSession(env, sidParam);
  if (!session) {
    return snapJson(introSnap(url.origin));
  }

  if (post.user.fid !== session.fid) {
    console.warn(
      `[values] FID mismatch on sid=${sidParam}: session=${session.fid} post=${post.user.fid}`
    );
    return snapJson(introSnap(url.origin));
  }

  if (session.index >= VALUES_LENGTH) {
    return renderSessionScene(session, url.origin, env);
  }

  const q = valuesQuestions[session.index];
  const answer = parseAnswer(q, post.inputs, url);
  if (!answer) {
    // Bad/missing payload — re-render the same question.
    return snapJson(questionSnap(session.id, session.index, url.origin));
  }

  session.answers.push(answer);
  session.index += 1;

  // Not done → next question. Save and short-circuit before the LLM call.
  if (session.index < VALUES_LENGTH) {
    await saveSession(env, session);
    return snapJson(questionSnap(session.id, session.index, url.origin));
  }

  // Done → persist completion (private by default per format='quiz') + index
  // by FID so revisits skip straight to result.
  await saveFidIndex(env, session.fid, session.id);

  // Run the open-text classifier once at completion. Best-effort: if the
  // model call fails, scores will be null and the result is Likert-only.
  // Latency is intentional here — the user is already waiting for the
  // result snap, so running sync means the mini-app loads instantly with
  // cached scores instead of paying the LLM cost on first /values/result
  // hit.
  session.openTextScores = await classifyOpenText(env, session.answers);

  // Airdrop pipeline (Neynar gate, cohort cap, vault distribute, ledger).
  // Best-effort: a Neynar/RPC failure shouldn't block the result snap.
  let airdropOutcome: AirdropOutcome;
  try {
    airdropOutcome = await runValuesAirdrop({ env, fid: session.fid, sid: session.id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[values] airdrop pipeline threw:', msg);
    airdropOutcome = { kind: 'error', error: msg };
  }
  applyOutcomeToSession(session, airdropOutcome);
  await saveSession(env, session);

  const free = freeTierResult(session.answers, session.openTextScores);
  try {
    session.completionId = await createQuizCompletion(env, {
      quizId: 'values',
      userId: session.fid,
      answersJson: JSON.stringify(session.answers),
      scores: { ...free.scores, dominant: free.dominant, secondary: free.secondary },
      resultCategory: free.dominant,
    });
    await saveSession(env, session); // the result page offers the chooser for this completion
  } catch (e) {
    // Non-fatal — don't block the snap response if D1/QStorage hiccups.
    console.error('[values] Failed to create quiz completion:', e);
  }

  return snapJson(
    resultSnap(
      session.id,
      free,
      outcomeToStatus(airdropOutcome),
      url.origin,
      miniappOrigin(env, url.origin),
    ),
  );
}

// Pull cached open-text scores or run the classifier and cache. Used by the
// API endpoints below so the mini-app result page + export both see the
// same blended scores.
async function getOrComputeOpenTextScores(
  env: Env,
  session: ValuesSession,
): Promise<Omit<ValuesScore, 'confidence'> | null> {
  if (session.openTextScores !== undefined) return session.openTextScores;
  const scores = await classifyOpenText(env, session.answers);
  session.openTextScores = scores;
  await saveSession(env, session);
  return scores;
}

// Lazy LLM-generated per-dim narratives. Cached on the session blob so the
// Claude call only runs once per completed session. Falls back to static
// dimNarratives on failure so the page always renders. Cached entries from
// older prompt/model versions are treated as stale and regenerated.
async function getOrComputeDimNarratives(
  env: Env,
  session: ValuesSession,
  scores: ValuesScore,
  forceRegen = false,
): Promise<{ content: DimNarratives; source: 'llm' | 'static'; error?: string }> {
  const cachedFresh =
    !forceRegen &&
    session.dimNarratives &&
    session.dimNarrativesVersion === DIM_NARRATIVES_VERSION;
  if (cachedFresh) {
    return { content: session.dimNarratives as DimNarratives, source: 'llm' };
  }
  const { narratives, error } = await generateDimNarratives(
    env,
    scores,
    session.answers,
  );
  session.dimNarratives = narratives ?? null;
  session.dimNarrativesVersion = DIM_NARRATIVES_VERSION;
  await saveSession(env, session);
  return narratives
    ? { content: narratives, source: 'llm' }
    : { content: dimNarratives as DimNarratives, source: 'static', error };
}

// Re-run the airdrop pipeline on result-page load when prior runs were
// non-terminal (disabled / errored) or never attempted. Catches users who
// completed before VALUES_AIRDROP_ENABLED was set, or whose airdrop hit a
// transient Neynar/RPC failure. The D1 dedup on (quiz_id, fid) is the
// idempotency lock — a re-run after a real success is harmless.
const AIRDROP_RETRYABLE = new Set<string | undefined>(['disabled', 'error', undefined]);

async function retryAirdropIfNeeded(env: Env, session: ValuesSession): Promise<void> {
  if (!AIRDROP_RETRYABLE.has(session.airdropStatus)) return;
  if (session.airdropped) return;
  try {
    const outcome = await runValuesAirdrop({
      env,
      fid: session.fid,
      sid: session.id,
    });
    applyOutcomeToSession(session, outcome);
    await saveSession(env, session);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[values] airdrop retry threw:', msg);
    session.airdropStatus = 'error';
    await saveSession(env, session);
  }
}

function renderSessionScene(
  session: ValuesSession,
  origin: string,
  env: Env
): Response {
  if (session.index >= VALUES_LENGTH) {
    // For re-renders we rely on the cached openTextScores (set at completion).
    // If absent (legacy session pre-classifier rollout), the result still
    // renders — just without the open-text blend. The mini-app's API call
    // will run the classifier on its first hit and cache it for next time.
    const status: AirdropStatus = session.airdropTxHash
      ? {
          kind: 'success',
          txHash: session.airdropTxHash,
          amountTokens: session.airdropAmountTokens ?? '4420000',
        }
      : session.airdropStatus
        ? rehydrateStatus(session)
        : { kind: 'pending' };
    return snapJson(
      resultSnap(
        session.id,
        freeTierResult(session.answers, session.openTextScores),
        status,
        origin,
        miniappOrigin(env, origin)
      )
    );
  }
  return snapJson(questionSnap(session.id, session.index, origin));
}

function applyOutcomeToSession(session: ValuesSession, outcome: AirdropOutcome) {
  session.airdropStatus = outcome.kind;
  if (outcome.kind === 'success') {
    session.airdropped = true;
    session.airdropTxHash = outcome.txHash;
    session.airdropAmountTokens = outcome.amountTokens;
  } else if (outcome.kind === 'already_claimed') {
    session.airdropped = true;
    session.airdropTxHash = outcome.txHash;
    session.airdropAmountTokens = '4420000';
  }
}

function outcomeToStatus(outcome: AirdropOutcome): AirdropStatus {
  switch (outcome.kind) {
    case 'success':
      return {
        kind: 'success',
        txHash: outcome.txHash,
        amountTokens: outcome.amountTokens,
      };
    case 'already_claimed':
      return { kind: 'already_claimed', txHash: outcome.txHash };
    case 'pool_exhausted':
      return { kind: 'pool_exhausted' };
    case 'not_eligible':
      return { kind: 'not_eligible', reason: outcome.reason };
    case 'disabled':
      return { kind: 'disabled' };
    case 'error':
      return { kind: 'pending' };
  }
}

function rehydrateStatus(session: ValuesSession): AirdropStatus {
  switch (session.airdropStatus) {
    case 'pool_exhausted':
      return { kind: 'pool_exhausted' };
    case 'disabled':
      return { kind: 'disabled' };
    case 'not_eligible':
      return { kind: 'not_eligible', reason: 'score' };
    default:
      return { kind: 'pending' };
  }
}

// ─── Answer parsing ──────────────────────────────────────────────────────
// Snap inputs come through differently per question type:
//   likert  → inputs.value is a number 1-5 (slider name='value')
//   forced  → choice is in URL query (each option is its own submit button)
//   open    → inputs.value is a string (text input name='value')

function parseAnswer(
  q: typeof valuesQuestions[number],
  inputs: Record<string, unknown>,
  url: URL,
): ValuesAnswer | null {
  if (q.type === 'likert') {
    const raw = inputs.value;
    const num = typeof raw === 'number' ? raw : Number(raw);
    // Slider may be absent from inputs if the user didn't drag it — fall back
    // to the default (3 = neutral) so untouched submissions count as neutral.
    const slider = Number.isFinite(num) ? num : 3;
    const clamped = Math.max(1, Math.min(5, Math.round(slider)));
    // Slider value 1..5 → scorer position 0..4; verify the position maps to
    // a defined LIKERT_ANSWER_WEIGHTS entry.
    const position = clamped - 1;
    if (LIKERT_ANSWER_WEIGHTS[position] === undefined) return null;
    return { questionId: q.id, type: 'likert', position };
  }

  if (q.type === 'forced') {
    const fromUrl = url.searchParams.get('choice');
    const fromInputs = typeof inputs.choice === 'string' ? inputs.choice : null;
    const choice = fromUrl ?? fromInputs;
    if (!choice) return null;
    const optionIndex = q.a_options.findIndex((o) => o.label === choice);
    if (optionIndex < 0) return null;
    return { questionId: q.id, type: 'forced', optionIndex };
  }

  // open
  const raw = inputs.value;
  const text = typeof raw === 'string' ? raw : '';
  // Allow empty text (lets user skip without getting stuck). Empty answers
  // contribute no signal to the LLM open-text classifier at result time.
  return { questionId: q.id, type: 'open', text };
}


// ─── values JSON API (non-snap) ──────────────────────────────────────────
// GET /api/values/session?sid=X — auth required; returns the user's session
// summary + computed free-tier result if the quiz is complete. The mini-app
// result page consumes this. Gated content (per-dim narratives) is included
// only when the live $QQ-balance gate is open.

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

export async function handleValuesApi(
  request: Request,
  env: Env
): Promise<Response | null> {
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: API_CORS_HEADERS });
  }

  // GET /api/values/shape/v{N}/:sid.png — public radar-shape image for the
  // result snap. R2-cached after first generation; no auth (the PNG is
  // already the public artifact the snap host links to). The version
  // segment lives in the URL so that CDN/snap-host edge caches treat each
  // version as a distinct resource — bumping the URL in snap.ts is enough
  // to invalidate stale cached renders without needing a manual purge.
  {
    const m = url.pathname.match(
      /^\/api\/values\/shape\/(v\d+)\/([A-Za-z0-9_-]+)\.png$/,
    );
    if (m && request.method === 'GET') {
      const version = m[1];
      const sid = m[2];
      const r2Key = `values/shape/${version}/${sid}.png`;

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
        console.error('[values shape] R2 get failed:', e);
      }

      const session = await loadSession(env, sid);
      if (!session) return new Response('Not found', { status: 404 });
      if (session.index < VALUES_LENGTH) {
        return new Response('Quiz not complete', { status: 400 });
      }

      const openText = await getOrComputeOpenTextScores(env, session);
      const result = freeTierResult(session.answers, openText);

      let pngBytes: Uint8Array;
      try {
        pngBytes = await renderShapePng(env, result.scores, { badge: result.badge });
      } catch (e) {
        console.error('[values shape] render failed:', e);
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
        console.error('[values shape] R2 put failed (still returning PNG):', e);
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

  // GET /api/values/session?sid=X
  if (url.pathname === '/api/values/session' && request.method === 'GET') {
    const auth = await authenticateFid(request, env);
    if (auth instanceof Response) return auth;

    const sid = url.searchParams.get('sid');
    if (!sid) return jsonResponse({ error: 'Missing sid parameter' }, 400);

    const session = await loadSession(env, sid);
    if (!session) return jsonResponse({ error: 'Session not found' }, 404);
    if (session.fid !== auth.fid) {
      return jsonResponse({ error: 'FID mismatch' }, 403);
    }

    const completed = session.index >= VALUES_LENGTH;

    // Mid-quiz callers get session progress only. Skip the gate check (no
    // result to gate yet) and tell the client to send the user back to
    // /snap/values to keep answering.
    if (!completed) {
      return jsonResponse({
        session: {
          id: session.id, fid: session.fid, index: session.index,
          total: VALUES_LENGTH, completed: false, createdAt: session.createdAt,
        },
        result: null,
        gated: null,
        dimContent: null,
      });
    }

    const openText = await getOrComputeOpenTextScores(env, session);
    const result = freeTierResult(session.answers, openText);

    // Run airdrop-retry + gate check in parallel — both are independent
    // Neynar + RPC hits, no reason to serialize them.
    const [, gateRes] = await Promise.all([
      retryAirdropIfNeeded(env, session),
      checkQQGate(env, session.fid).catch((e) => {
        console.error('[values] gate check failed:', e);
        return {
          unlocked: false,
          balance: '0',
          threshold: '0',
          address: null,
        };
      }),
    ]);
    const gate = gateRes;

    // dim narratives are NOT computed here — they're a separate fetch
    // (/api/values/dim-narratives) so the free tier paints fast and the
    // breakdown streams in afterward. Saves ~5-10s of perceived load time.

    return jsonResponse({
      session: {
        id: session.id, fid: session.fid, index: session.index,
        total: VALUES_LENGTH, completed: true, createdAt: session.createdAt,
      },
      result,
      gated: gate,
      completion: await completionSummary(env, 'values', session.fid, session.completionId),
      airdrop: {
        status: session.airdropStatus ?? 'pending',
        txHash: session.airdropTxHash ?? null,
        amountTokens: session.airdropAmountTokens ?? null,
      },
    });
  }

  // GET /api/values/dim-narratives?sid=X[&regen=1]
  // Phase-2 fetch for the result mini-app. The session endpoint stays fast
  // and paints the free tier; this endpoint owns the slow Gemma call. Gated
  // — re-checks the $QQ balance so a paused gate can't produce free reads.
  if (url.pathname === '/api/values/dim-narratives' && request.method === 'GET') {
    const auth = await authenticateFid(request, env);
    if (auth instanceof Response) return auth;

    const sid = url.searchParams.get('sid');
    if (!sid) return jsonResponse({ error: 'Missing sid parameter' }, 400);

    const session = await loadSession(env, sid);
    if (!session) return jsonResponse({ error: 'Session not found' }, 404);
    if (session.fid !== auth.fid) return jsonResponse({ error: 'FID mismatch' }, 403);
    if (session.index < VALUES_LENGTH) {
      return jsonResponse({ error: 'Quiz not complete' }, 400);
    }

    let gate;
    try {
      gate = await checkQQGate(env, session.fid);
    } catch (e) {
      console.error('[values] gate check failed:', e);
      return jsonResponse({ error: 'Gate check failed' }, 503);
    }
    if (!gate.unlocked) {
      return jsonResponse(
        { error: 'Locked', balance: gate.balance, threshold: gate.threshold },
        403,
      );
    }

    const openText = await getOrComputeOpenTextScores(env, session);
    const result = freeTierResult(session.answers, openText);
    const forceRegen = url.searchParams.get('regen') === '1';
    const dim = await getOrComputeDimNarratives(
      env,
      session,
      result.scores,
      forceRegen,
    );

    return jsonResponse({
      dimContent: dim.content,
      source: dim.source,
      error: dim.error ?? null,
    });
  }

  // GET /api/values/export?sid=X
  // Returns the user's context card as text/markdown, gated behind a fresh
  // $QQ-balance check. The display gate on /api/values/session can be
  // spoofed client-side; this re-check makes the export trustless: a user
  // who hasn't earned the unlock cannot pull the artifact.
  if (url.pathname === '/api/values/export' && request.method === 'GET') {
    const auth = await authenticateFid(request, env);
    if (auth instanceof Response) return auth;

    const sid = url.searchParams.get('sid');
    if (!sid) return jsonResponse({ error: 'Missing sid parameter' }, 400);

    const session = await loadSession(env, sid);
    if (!session) return jsonResponse({ error: 'Session not found' }, 404);
    if (session.fid !== auth.fid) return jsonResponse({ error: 'FID mismatch' }, 403);
    if (session.index < VALUES_LENGTH) {
      return jsonResponse({ error: 'Quiz not complete' }, 400);
    }

    const gate = await checkQQGate(env, session.fid);
    if (!gate.unlocked) {
      return jsonResponse(
        {
          error: 'Locked',
          balance: gate.balance,
          threshold: gate.threshold,
        },
        403,
      );
    }

    const openText = await getOrComputeOpenTextScores(env, session);
    const result = freeTierResult(session.answers, openText);
    const dim = await getOrComputeDimNarratives(env, session, result.scores);
    const markdown = buildContextCardMarkdown({
      result,
      answers: session.answers,
      dimContent: dim.content,
      generatedAt: new Date(),
    });

    return new Response(markdown, {
      status: 200,
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
        // Filename keeps the sid so users with multiple completions don't
        // overwrite previous exports if they re-take the quiz.
        'Content-Disposition': `attachment; filename="values-${sid}.md"`,
        ...API_CORS_HEADERS,
      },
    });
  }

  // ── Compatibility (docs/quizzes/CONTENT-PLAN.md §7.5, card t_990220e3) ──
  // The completion id is the capability: a random UUID only its owner ever
  // sees, so a URL carrying it is a link the owner chose to hand out.

  // GET /api/values/compare/me — the caller's own latest values completion,
  // the handle their compare link is built from.
  if (url.pathname === '/api/values/compare/me' && request.method === 'GET') {
    const flex = await requireFlexibleAuth(request, env);
    if (!flex.authenticated || !flex.fid) {
      return jsonResponse({ error: flex.error || 'Unauthorized' }, 401);
    }
    const completion = await latestValuesCompletion(env, flex.fid);
    return jsonResponse({ completion });
  }

  // GET /api/values/compare?a=ID[&b=ID]
  // Two ids → the comparison, no sign-in needed (both ids are the capability).
  // One id → the signed-in caller's latest completion is `b`; the response
  // says what the page should do when there is no such completion
  // (`no_completion`), when `a` is the caller's own (`self`), or when nobody
  // is signed in (`sign_in`, with `a`'s card so the page can name them).
  if (url.pathname === '/api/values/compare' && request.method === 'GET') {
    const a = url.searchParams.get('a');
    const bParam = url.searchParams.get('b');
    if (!a || !isCompletionId(a) || (bParam && !isCompletionId(bParam))) {
      return jsonResponse({ error: 'bad_request' }, 400);
    }
    const viewerFid = await getOptionalAuth(request, env);

    let b = bParam;
    if (!b) {
      const card = await cardForCompletion(env, a);
      if (!card) return jsonResponse({ error: 'not_found' }, 404);
      if (viewerFid === undefined) return jsonResponse({ status: 'sign_in', a: card });
      const mine = await latestValuesCompletion(env, viewerFid);
      if (!mine) return jsonResponse({ status: 'no_completion', a: card });
      if (mine.id === a || card.fid === viewerFid) return jsonResponse({ status: 'self', a: card });
      b = mine.id;
    }

    const result = await compareCompletions(env, a, b, { viewerFid });
    if (!result) return jsonResponse({ error: 'not_found' }, 404);
    return jsonResponse(result, 200);
  }

  // ── Web quiz endpoints (browser flow at /quiz/values) ────────────────

  // GET /api/values/web/state[?sid=X]
  if (url.pathname === '/api/values/web/state' && request.method === 'GET') {
    const flex = await requireFlexibleAuth(request, env);
    if (!flex.authenticated || !flex.fid) {
      return jsonResponse({ error: flex.error || 'Unauthorized' }, 401);
    }
    const sidParam = url.searchParams.get('sid');
    let session = sidParam ? await loadSession(env, sidParam) : null;
    if (session && session.fid !== flex.fid) session = null;
    if (!session) session = await loadSessionForFid(env, flex.fid);
    return jsonResponse({
      total: VALUES_LENGTH,
      questions: valuesWebQuestions(),
      session: session ? valuesSessionSummary(session) : null,
    });
  }

  // POST /api/values/web/start
  if (url.pathname === '/api/values/web/start' && request.method === 'POST') {
    const flex = await requireFlexibleAuth(request, env);
    if (!flex.authenticated || !flex.fid) {
      return jsonResponse({ error: flex.error || 'Unauthorized' }, 401);
    }
    const existing = await loadSessionForFid(env, flex.fid);
    if (existing) return jsonResponse(valuesSessionSummary(existing));
    const sid = newSessionId();
    const session = newSession(sid, flex.fid);
    await saveSession(env, session);
    return jsonResponse(valuesSessionSummary(session));
  }

  // POST /api/values/web/answer { sid, position? | optionIndex? | text? }
  if (url.pathname === '/api/values/web/answer' && request.method === 'POST') {
    const flex = await requireFlexibleAuth(request, env);
    if (!flex.authenticated || !flex.fid) {
      return jsonResponse({ error: flex.error || 'Unauthorized' }, 401);
    }
    let body: { sid?: string; position?: number; optionIndex?: number; text?: string };
    try {
      body = await request.json() as typeof body;
    } catch {
      return jsonResponse({ error: 'Invalid JSON body' }, 400);
    }
    if (!body.sid) return jsonResponse({ error: 'sid required' }, 400);

    const session = await loadSession(env, body.sid);
    if (!session) return jsonResponse({ error: 'session not found' }, 404);
    if (session.fid !== flex.fid) {
      return jsonResponse({ error: 'wrong fid' }, 403);
    }
    if (session.index >= VALUES_LENGTH) {
      return jsonResponse(valuesSessionSummary(session));
    }

    const q = valuesQuestions[session.index];
    let answer: ValuesAnswer | null = null;
    if (q.type === 'likert') {
      const pos = body.position;
      if (typeof pos === 'number' && pos >= 0 && pos <= 4 && Number.isInteger(pos)) {
        answer = { questionId: q.id, type: 'likert', position: pos };
      }
    } else if (q.type === 'forced') {
      const oi = body.optionIndex;
      if (typeof oi === 'number' && (oi === 0 || oi === 1)) {
        answer = { questionId: q.id, type: 'forced', optionIndex: oi };
      }
    } else {
      // open — accept the trimmed string; empty is allowed (mirrors snap)
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      answer = { questionId: q.id, type: 'open', text };
    }
    if (!answer) return jsonResponse({ error: 'invalid answer' }, 400);

    session.answers.push(answer);
    session.index += 1;

    // Mid-quiz: persist & return.
    if (session.index < VALUES_LENGTH) {
      await saveSession(env, session);
      return jsonResponse(valuesSessionSummary(session));
    }

    // Completion: mirror the snap completion path so the result page sees
    // the same state. Open-text classifier + airdrop + quiz_completion +
    // FID-index. Errors are best-effort — the user has already finished.
    await saveFidIndex(env, session.fid, session.id);
    try {
      session.openTextScores = await classifyOpenText(env, session.answers);
    } catch (e) {
      console.error('[values/web] classifyOpenText failed:', e);
      session.openTextScores = null;
    }
    let airdropOutcome: AirdropOutcome;
    try {
      airdropOutcome = await runValuesAirdrop({
        env,
        fid: session.fid,
        sid: session.id,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[values/web] airdrop pipeline threw:', msg);
      airdropOutcome = { kind: 'error', error: msg };
    }
    applyOutcomeToSession(session, airdropOutcome);
    await saveSession(env, session);

    const free = freeTierResult(session.answers, session.openTextScores);
    try {
      session.completionId = await createQuizCompletion(env, {
        quizId: 'values',
        userId: session.fid,
        answersJson: JSON.stringify(session.answers),
        scores: { ...free.scores, dominant: free.dominant, secondary: free.secondary },
        resultCategory: free.dominant,
      });
      await saveSession(env, session);
    } catch (e) {
      console.error('[values/web] Failed to create quiz completion:', e);
    }

    return jsonResponse(valuesSessionSummary(session));
  }

  return null;
}

// ── Web quiz helpers ─────────────────────────────────────────────────────

interface ValuesWebQuestion {
  id: string;
  stem: string;
  type: 'likert' | 'forced' | 'open';
  a_options?: { label: string }[];
}

function valuesWebQuestions(): ValuesWebQuestion[] {
  return valuesQuestions.map((q) => {
    if (q.type === 'likert') {
      return { id: q.id, stem: q.stem, type: 'likert' as const };
    }
    if (q.type === 'open') {
      return { id: q.id, stem: q.stem, type: 'open' as const };
    }
    return {
      id: q.id,
      stem: q.stem,
      type: 'forced' as const,
      a_options: q.a_options.map((o) => ({ label: o.label })),
    };
  });
}

function valuesSessionSummary(s: ValuesSession): {
  sid: string; fid: number; index: number; total: number; completed: boolean; createdAt: number;
} {
  return {
    sid: s.id,
    fid: s.fid,
    index: s.index,
    total: VALUES_LENGTH,
    completed: s.index >= VALUES_LENGTH,
    createdAt: s.createdAt,
  };
}
