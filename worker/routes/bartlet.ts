/**
 * bartlet — snap route handler.
 *
 * Mounted at `/snap/bartlet` by worker/routes/snap.ts.
 *
 * State machine (see SPEC §6):
 *   GET  /snap/bartlet                    → intro
 *   POST /snap/bartlet?start=1            → create session, return q0
 *   POST /snap/bartlet?sid=SID            → append answer, return next q OR result
 *   GET  /snap/bartlet?sid=SID            → re-render whatever scene the session is on
 *                                           (shared result URLs render as result cards)
 *
 * Session state lives in KV (BARTLET_SESSIONS). Airdrop dedup is enforced at
 * the D1 level via bartlet_airdrops.fid primary key.
 */

import { parseSnapRequestCompat } from '../services/snapCompat';
import { SNAP_CONTENT_TYPE, introSnap, questionSnap, resultSnap, shareSnap, type AirdropStatus } from '../services/bartlet/snap';
import {
  loadSession,
  loadSessionForFid,
  newSession,
  newSessionId,
  saveFidIndex,
  saveSession,
  type BartletSession,
} from '../services/bartlet/session';
import { BARTLET_LENGTH, bartletQuestions } from '../services/bartlet/questions';
import { freeTierResult, paidTierResult } from '../services/bartlet/scoring';
import { runAirdrop, fetchNeynarUser, pickRecipientAddress, type AirdropOutcome } from '../services/bartlet/airdrop';
import { createQuizCompletion, completionSummary } from './quiz-completions';
import { AuthService } from '../services/AuthService';
import { requireFlexibleAuth } from '../middleware/auth';
import { createPublicClient, http, keccak256, toBytes, type Hex } from 'viem';
import { base } from 'viem/chains';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

export const BARTLET_PATH = '/snap/bartlet';
// Dev alias — same handler, different path, used to iterate without fighting
// Farcaster's snap embed cache. Ship production demo from /snap/bartlet.
export const BARTLET_DEV_PATH = '/snap/bartlet-dev';

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

function unlockOrigin(env: Env, reqOrigin: string): string {
  // The mini app unlock lives at the main qbase origin. Allow override via env
  // for dev. Defaults to the request origin so it Just Works in prod.
  return (env.BARTLET_UNLOCK_ORIGIN as string | undefined) || reqOrigin;
}

export async function handleBartletSnap(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);

  // CORS preflight — the snap emulator at farcaster.xyz does a cross-origin
  // fetch to this worker and requires the allow-origin/methods headers.
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
    console.warn('[bartlet] parseRequest failed:', parsed.error);
    return Response.json({ error: parsed.error }, { status: 400 });
  }

  const sidParam = url.searchParams.get('sid');
  const isStart = url.searchParams.get('start') === '1';

  // ─── GET paths ───────────────────────────────────────────────────────
  if (parsed.action.type === 'get') {
    // Share card: ?share=explorer renders a shareable result card with the
    // archetype image + "Take the quiz" button for viewers.
    const shareType = url.searchParams.get('share');
    if (shareType) {
      return snapJson(shareSnap(shareType, url.origin));
    }
    // GET with sid → re-render the session's current scene (result if done).
    if (sidParam) {
      const session = await loadSession(env, sidParam);
      if (session) return renderSessionScene(session, url.origin, env);
    }
    // Fresh intro.
    return snapJson(introSnap(url.origin));
  }

  const post = parsed.action; // narrowed to 'post'

  // ─── POST: start ─────────────────────────────────────────────────────
  if (isStart) {
    const fid = post.user.fid;
    // If this FID has already completed the bartlet, jump straight to their
    // saved result card. Mid-quiz sessions aren't resumed — they get a fresh
    // run.
    const prior = await loadSessionForFid(env, fid);
    if (prior && prior.index >= BARTLET_LENGTH) {
      return renderSessionScene(prior, url.origin, env);
    }
    const sid = newSessionId();
    const session = newSession(sid, fid);
    await saveSession(env, session);
    return snapJson(questionSnap(sid, 0, url.origin));
  }

  // ─── POST: answer ────────────────────────────────────────────────────
  if (!sidParam) {
    // Unknown POST shape; re-show intro.
    return snapJson(introSnap(url.origin));
  }

  const session = await loadSession(env, sidParam);
  if (!session) {
    return snapJson(introSnap(url.origin));
  }

  const postFid = post.user.fid;
  if (postFid !== session.fid) {
    console.warn(
      `[bartlet] FID mismatch on sid=${sidParam}: session=${session.fid} post=${postFid}`
    );
    return snapJson(introSnap(url.origin));
  }

  // If the session is already complete, just re-render the result.
  if (session.index >= BARTLET_LENGTH) {
    return renderSessionScene(session, url.origin, env);
  }

  // Append the answer for the current question. The question scene renders
  // each option as its own submit button whose target URL encodes `choice`
  // in the query string (snap's submit action can't carry form inputs from a
  // button, only a target). We still fall back to inputs.choice if present.
  const urlChoice = url.searchParams.get('choice');
  const choice =
    urlChoice ||
    (typeof post.inputs.choice === 'string' ? post.inputs.choice : null);
  if (!choice) {
    // User submitted without choosing; re-render the same question.
    return snapJson(questionSnap(session.id, session.index, url.origin));
  }

  const q = bartletQuestions[session.index];
  const optionIndex = q.a_options.findIndex((o) => o.label === choice);
  if (optionIndex < 0) {
    return snapJson(questionSnap(session.id, session.index, url.origin));
  }

  session.answers.push({ queryId: q.id, optionIndex });
  session.index += 1;
  await saveSession(env, session);

  // Not done yet → next question.
  if (session.index < BARTLET_LENGTH) {
    return snapJson(questionSnap(session.id, session.index, url.origin));
  }

  // Done → airdrop + result scene. Also index by FID so revisits can skip
  // straight to the result card without re-taking the quiz.
  const outcome = await runAirdrop({ env, fid: session.fid, sid: session.id });
  applyOutcomeToSession(session, outcome);
  await saveSession(env, session);
  await saveFidIndex(env, session.fid, session.id);

  // Persist to quiz_completions (private by default).
  const freeResult = freeTierResult(session.answers);
  try {
    session.completionId = await createQuizCompletion(env, {
      quizId: 'bartlet',
      userId: session.fid,
      answersJson: JSON.stringify(session.answers),
      scores: {
        dominant: freeResult.dominant,
        runnerUp: freeResult.runnerUp,
        hybrid: freeResult.hybrid,
        displayLabel: freeResult.displayLabel,
      },
      resultCategory: freeResult.displayLabel,
    });
    await saveSession(env, session); // the result page offers the chooser for this completion
  } catch (e) {
    // Non-fatal — don't block the snap response if D1/QStorage hiccups
    console.error('[bartlet] Failed to create quiz completion:', e);
  }

  return snapJson(
    resultSnap(
      session.id,
      freeResult,
      outcomeToStatus(outcome),
      url.origin,
      unlockOrigin(env, url.origin)
    )
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function renderSessionScene(
  session: BartletSession,
  origin: string,
  env: Env
): Response {
  if (session.index >= BARTLET_LENGTH) {
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
        freeTierResult(session.answers),
        status,
        origin,
        unlockOrigin(env, origin)
      )
    );
  }
  return snapJson(questionSnap(session.id, session.index, origin));
}

function applyOutcomeToSession(session: BartletSession, outcome: AirdropOutcome) {
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

function rehydrateStatus(session: BartletSession): AirdropStatus {
  const kind = session.airdropStatus;
  switch (kind) {
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

// ─── Bartlet API (non-snap) ────────────────────────────────────────────────

const API_CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

function jsonResponse(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: API_CORS_HEADERS,
  });
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

const BARTLET_CONTENT_ID = keccak256(toBytes('bartlet'));

const gateAbi = [
  {
    name: 'hasAccess',
    type: 'function',
    inputs: [
      { name: 'contentId', type: 'bytes32' },
      { name: 'user', type: 'address' },
    ],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'view',
  },
] as const;

export async function handleBartletApi(
  request: Request,
  env: Env
): Promise<Response | null> {
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: API_CORS_HEADERS });
  }

  // GET /api/bartlet/session?sid=XYZ
  if (url.pathname === '/api/bartlet/session' && request.method === 'GET') {
    const auth = await authenticateFid(request, env);
    if (auth instanceof Response) return auth;

    const sid = url.searchParams.get('sid');
    if (!sid) return jsonResponse({ error: 'Missing sid parameter' }, 400);

    const session = await loadSession(env, sid);
    if (!session) return jsonResponse({ error: 'Session not found' }, 404);
    if (session.fid !== auth.fid) {
      return jsonResponse({ error: 'FID mismatch' }, 403);
    }

    return jsonResponse({
      session: {
        id: session.id,
        fid: session.fid,
        answers: session.answers,
        paid: session.paid,
        airdropped: session.airdropped,
        airdropTxHash: session.airdropTxHash,
      },
      completion: await completionSummary(env, 'bartlet', session.fid, session.completionId),
    });
  }

  // POST /api/bartlet/unlock
  if (url.pathname === '/api/bartlet/unlock' && request.method === 'POST') {
    const auth = await authenticateFid(request, env);
    if (auth instanceof Response) return auth;

    let body: { sid?: string; txHash?: string };
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: 'Invalid JSON body' }, 400);
    }

    const { sid, txHash } = body;
    if (!sid || !txHash) {
      return jsonResponse({ error: 'Missing sid or txHash' }, 400);
    }

    const session = await loadSession(env, sid);
    if (!session) return jsonResponse({ error: 'Session not found' }, 404);
    if (session.fid !== auth.fid) {
      return jsonResponse({ error: 'FID mismatch' }, 403);
    }

    // Already paid — return existing result
    if (session.paid) {
      return jsonResponse({ paid: paidTierResult(session.answers) });
    }

    // Resolve user's wallet address from FID via Neynar
    const neynarUser = await fetchNeynarUser(env, auth.fid);
    if (!neynarUser) {
      return jsonResponse({ error: 'Could not resolve user address' }, 500);
    }
    const userAddress = pickRecipientAddress(neynarUser);
    if (!userAddress) {
      return jsonResponse({ error: 'No verified address found for this FID' }, 400);
    }

    // Verify on-chain access via QbaseGate — retry with backoff since the
    // unlock tx may not be mined yet when the client submits.
    const rpcUrl = (env.BASE_RPC_URL as string) || 'https://base.llamarpc.com';
    const client = createPublicClient({ chain: base, transport: http(rpcUrl) });

    let unlocked = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        unlocked = await client.readContract({
          address: env.QBASE_GATE_ADDRESS as Hex,
          abi: gateAbi,
          functionName: 'hasAccess',
          args: [BARTLET_CONTENT_ID, userAddress as Hex],
        }) as boolean;
        if (unlocked) break;
      } catch {
        // RPC error — retry
      }
      if (attempt < 4) {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      }
    }

    if (!unlocked) {
      return jsonResponse(
        { error: 'No unlock found on-chain for this user. If you just paid, try again in a few seconds.' },
        400
      );
    }

    // Flip paid, save session
    session.paid = true;
    await saveSession(env, session);

    // Cache in D1 for analytics (onchain state is source of truth)
    try {
      await env.DB.prepare(
        'INSERT OR IGNORE INTO bartlet_unlocks (tx_hash, sid, fid, amount, created_at) VALUES (?, ?, ?, ?, ?)'
      )
        .bind(txHash || 'gate-verified', sid, auth.fid, '2210000', Date.now())
        .run();
    } catch {
      // Non-fatal — onchain state is authoritative
    }

    return jsonResponse({ paid: paidTierResult(session.answers) });
  }

  // ── Web quiz endpoints (browser flow at /quiz/bartlet) ───────────────

  // GET /api/bartlet/web/state[?sid=X]
  if (url.pathname === '/api/bartlet/web/state' && request.method === 'GET') {
    const flex = await requireFlexibleAuth(request, env);
    if (!flex.authenticated || !flex.fid) {
      return jsonResponse({ error: flex.error || 'Unauthorized' }, 401);
    }
    const sidParam = url.searchParams.get('sid');
    let session = sidParam ? await loadSession(env, sidParam) : null;
    if (session && session.fid !== flex.fid) session = null;
    if (!session) session = await loadSessionForFid(env, flex.fid);
    return jsonResponse({
      total: BARTLET_LENGTH,
      questions: bartletWebQuestions(),
      session: session ? bartletSessionSummary(session) : null,
    });
  }

  // POST /api/bartlet/web/start
  if (url.pathname === '/api/bartlet/web/start' && request.method === 'POST') {
    const flex = await requireFlexibleAuth(request, env);
    if (!flex.authenticated || !flex.fid) {
      return jsonResponse({ error: flex.error || 'Unauthorized' }, 401);
    }
    const existing = await loadSessionForFid(env, flex.fid);
    if (existing) return jsonResponse(bartletSessionSummary(existing));
    const sid = newSessionId();
    const session = newSession(sid, flex.fid);
    await saveSession(env, session);
    return jsonResponse(bartletSessionSummary(session));
  }

  // POST /api/bartlet/web/answer { sid, optionIndex }
  if (url.pathname === '/api/bartlet/web/answer' && request.method === 'POST') {
    const flex = await requireFlexibleAuth(request, env);
    if (!flex.authenticated || !flex.fid) {
      return jsonResponse({ error: flex.error || 'Unauthorized' }, 401);
    }

    let body: { sid?: string; optionIndex?: number };
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
    if (session.index >= BARTLET_LENGTH) {
      return jsonResponse(bartletSessionSummary(session));
    }

    const q = bartletQuestions[session.index];
    const oi = body.optionIndex;
    if (typeof oi !== 'number' || !Number.isInteger(oi) || oi < 0 || oi >= q.a_options.length) {
      return jsonResponse({ error: 'invalid optionIndex' }, 400);
    }

    session.answers.push({ queryId: q.id, optionIndex: oi });
    session.index += 1;

    if (session.index < BARTLET_LENGTH) {
      await saveSession(env, session);
      return jsonResponse(bartletSessionSummary(session));
    }

    // Completion: mirror the snap completion path so the result page is
    // ready. airdrop + saveFidIndex + quiz_completion. All best-effort.
    let outcome: AirdropOutcome;
    try {
      outcome = await runAirdrop({ env, fid: session.fid, sid: session.id });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[bartlet/web] airdrop threw:', msg);
      outcome = { kind: 'error', error: msg };
    }
    applyOutcomeToSession(session, outcome);
    await saveSession(env, session);
    await saveFidIndex(env, session.fid, session.id);

    try {
      const free = freeTierResult(session.answers);
      session.completionId = await createQuizCompletion(env, {
        quizId: 'bartlet',
        userId: session.fid,
        answersJson: JSON.stringify(session.answers),
        scores: {
          dominant: free.dominant,
          runnerUp: free.runnerUp,
          hybrid: free.hybrid,
          displayLabel: free.displayLabel,
        },
        resultCategory: free.displayLabel,
      });
      await saveSession(env, session);
    } catch (e) {
      console.error('[bartlet/web] Failed to create quiz completion:', e);
    }

    return jsonResponse(bartletSessionSummary(session));
  }

  return null;
}

// ── Web quiz helpers ─────────────────────────────────────────────────────

interface BartletWebQuestion {
  id: string;
  stem: string;
  type: 'mc';
  a_options: { label: string }[];
}

function bartletWebQuestions(): BartletWebQuestion[] {
  return bartletQuestions.map((q) => ({
    id: q.id,
    stem: q.stem,
    type: 'mc' as const,
    a_options: q.a_options.map((o) => ({ label: o.label })),
  }));
}

function bartletSessionSummary(s: BartletSession): {
  sid: string; fid: number; index: number; total: number; completed: boolean; createdAt: number;
} {
  return {
    sid: s.id,
    fid: s.fid,
    index: s.index,
    total: BARTLET_LENGTH,
    completed: s.index >= BARTLET_LENGTH,
    createdAt: s.createdAt,
  };
}
