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

import { parseRequest } from '@farcaster/snap/server';
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
import { runAirdrop, type AirdropOutcome } from '../services/bartlet/airdrop';
import { AuthService } from '../services/AuthService';
import { createPublicClient, http, type Hex } from 'viem';
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
  'Access-Control-Allow-Headers': 'Content-Type, Accept',
  'Access-Control-Max-Age': '86400',
};

function snapJson(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: {
      'Content-Type': SNAP_CONTENT_TYPE,
      'Cache-Control': 'no-store',
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

  const parsed = await parseRequest(request, {
    skipJFSVerification: env.SNAP_SKIP_JFS === '1',
  });
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

  return snapJson(
    resultSnap(
      session.id,
      freeTierResult(session.answers),
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

// Minimum unlock payment: 2.21M $QQ with 18 decimals
const MIN_UNLOCK_AMOUNT = 2210000000000000000000000n; // 2_210_000 * 10^18

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

    // Verify on-chain transaction
    const rpcUrl = (env.BASE_RPC_URL as string) || 'https://base.llamarpc.com';
    const client = createPublicClient({ chain: base, transport: http(rpcUrl) });

    let receipt;
    try {
      receipt = await client.getTransactionReceipt({ hash: txHash as Hex });
    } catch (e) {
      return jsonResponse({ error: 'Could not fetch transaction receipt' }, 400);
    }

    if (receipt.status !== 'success') {
      return jsonResponse({ error: 'Transaction did not succeed' }, 400);
    }

    // Parse Transfer logs from the $QQ token contract
    const qqAddress = (env.QQ_CONTRACT_ADDRESS as string).toLowerCase();
    const treasuryAddress = (env.BARTLET_TREASURY_ADDRESS as string).toLowerCase();

    // ERC-20 Transfer event topic
    const transferTopic =
      '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

    const transferLog = receipt.logs.find(
      (log) =>
        log.address.toLowerCase() === qqAddress &&
        log.topics[0] === transferTopic &&
        log.topics[2] &&
        '0x' + log.topics[2].slice(26).toLowerCase() === treasuryAddress
    );

    if (!transferLog) {
      return jsonResponse(
        { error: 'No matching $QQ transfer to treasury found in tx' },
        400
      );
    }

    // Verify transfer amount (log.data is the uint256 value)
    const transferValue = BigInt(transferLog.data);
    if (transferValue < MIN_UNLOCK_AMOUNT) {
      return jsonResponse(
        { error: `Transfer amount too low: need at least 2.21M $QQ` },
        400
      );
    }

    // Dedup: check bartlet_unlocks for this txHash
    const existing = await env.DB.prepare(
      'SELECT tx_hash FROM bartlet_unlocks WHERE tx_hash = ?'
    )
      .bind(txHash)
      .first();
    if (existing) {
      return jsonResponse({ error: 'Transaction already used for an unlock' }, 409);
    }

    // Flip paid, save session
    session.paid = true;
    await saveSession(env, session);

    // Insert into D1
    await env.DB.prepare(
      'INSERT INTO bartlet_unlocks (tx_hash, sid, fid, amount, created_at) VALUES (?, ?, ?, ?, ?)'
    )
      .bind(txHash, sid, auth.fid, transferValue.toString(), Date.now())
      .run();

    return jsonResponse({ paid: paidTierResult(session.answers) });
  }

  return null;
}
