/**
 * apperception — snap route handler.
 *
 * Mounted at /snap/apperception by worker/routes/snap.ts.
 *
 * State machine:
 *   GET  /snap/apperception                      → intro, or resume session for FID
 *   GET  /snap/apperception?sid=SID              → re-render current scene
 *   GET  /snap/apperception?share&sid=SID        → share card
 *   POST /snap/apperception?start=1              → create session, return q0
 *   POST /snap/apperception?sid=SID              → record answer, return next q or result
 *   POST /snap/apperception?sid=SID&choice=LABEL → record forced-choice answer
 *
 * Session state in KV (APPERCEPTION_SESSIONS); answers in QStorage.
 */

import { parseSnapRequestCompat } from '../services/snapCompat';
import {
  SNAP_CONTENT_TYPE,
  introSnap,
  questionSnap,
  resultSnap,
  shareSnap,
  type AirdropStatus,
} from '../services/apperception/snap';
import {
  loadSession,
  loadSessionForFid,
  newSession,
  newSessionId,
  saveFidIndex,
  saveSession,
  type ApperceptionSession,
} from '../services/apperception/session';
import {
  APPERCEPTION_LENGTH,
  apperceptionQuestions,
} from '../services/apperception/questions';
import {
  freeTierResult,
  type ApperceptionAnswer,
} from '../services/apperception/scoring';
import { runApperceptionAirdrop } from '../services/apperception/airdrop';
import {
  hasApperceptionCompletion,
  writeApperceptionCompletion,
} from '../services/apperception/completion';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

export const APPERCEPTION_PATH = '/snap/apperception';
export const APPERCEPTION_DEV_PATH = '/snap/apperception-dev';

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
  return (env.APPERCEPTION_MINIAPP_ORIGIN as string | undefined) || reqOrigin;
}

export async function handleApperceptionSnap(
  request: Request,
  env: Env
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path !== APPERCEPTION_PATH && path !== APPERCEPTION_DEV_PATH) return null;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

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

  try {
    const parsed = await parseSnapRequestCompat(request, env);
    if (!parsed.success) {
      console.warn('[apperception] parseRequest failed:', parsed.error);
      return Response.json({ error: parsed.error }, { status: 400 });
    }

    const sidParam = url.searchParams.get('sid');
    const isStart = url.searchParams.get('start') === '1';
    const origin = url.origin;
    const mOrigin = miniappOrigin(env, origin);

    // ─── GET paths ────────────────────────────────────────────────────
    if (parsed.action.type === 'get') {
      const shareParam = url.searchParams.has('share');
      if (shareParam) {
        if (sidParam) {
          const session = await loadSession(env, sidParam);
          if (session && session.index >= APPERCEPTION_LENGTH) {
            return snapJson(shareSnap(sidParam, origin));
          }
        }
        return snapJson(shareSnap(origin));
      }
      if (sidParam) {
        const session = await loadSession(env, sidParam);
        if (session) return renderSessionScene(session, origin, mOrigin, env);
      }
      // Auto-resume from viewer FID
      const viewerFid = (parsed.action as { user?: { fid?: number } }).user?.fid;
      if (typeof viewerFid === 'number') {
        const session = await loadSessionForFid(env, viewerFid);
        if (session) return renderSessionScene(session, origin, mOrigin, env);
      }
      return snapJson(introSnap(origin));
    }

    const post = parsed.action;

    // ─── POST: start ──────────────────────────────────────────────────
    if (isStart) {
      const fid = post.user.fid;
      const prior = await loadSessionForFid(env, fid);
      if (prior && prior.index >= APPERCEPTION_LENGTH) {
        return renderSessionScene(prior, origin, mOrigin, env);
      }
      const sid = newSessionId();
      const session = newSession(sid, fid);
      await saveSession(env, session);
      return snapJson(questionSnap(sid, 0, origin));
    }

    // ─── POST: answer ─────────────────────────────────────────────────
    if (!sidParam) {
      return snapJson(introSnap(origin));
    }

    const session = await loadSession(env, sidParam);
    if (!session) {
      return snapJson(introSnap(origin));
    }

    if (session.fid !== post.user.fid) {
      return snapJson({ error: 'wrong fid' }, { status: 403 });
    }

    // Already completed
    if (session.index >= APPERCEPTION_LENGTH) {
      return renderSessionScene(session, origin, mOrigin, env);
    }

    // Parse answer
    const q = apperceptionQuestions[session.index];
    if (!q) return snapJson({ error: 'invalid index' }, { status: 400 });

    let answer: ApperceptionAnswer | null = null;

    if (q.type === 'likert') {
      // Value (1..5) comes from the tapped Likert button's target URL; fall
      // back to legacy slider inputs.value for back-compat.
      const raw = url.searchParams.get('value') ?? post.inputs?.value;
      const val = Number(raw ?? '');
      if (val >= 1 && val <= 5) {
        answer = {
          questionId: q.id,
          type: 'likert',
          position: val - 1,
        };
      }
    } else {
      // forced — choice is in URL params
      const choice = url.searchParams.get('choice');
      if (choice) {
        const idx = q.a_options.findIndex((o) => o.label === choice);
        if (idx >= 0) {
          answer = {
            questionId: q.id,
            type: 'forced',
            optionIndex: idx,
          };
        }
      }
    }

    if (!answer) return snapJson({ error: 'invalid answer' }, { status: 400 });

    // Record
    session.answers.push(answer);
    session.index++;
    await saveSession(env, session);

    // Check completion
    if (session.index >= APPERCEPTION_LENGTH) {
      await saveFidIndex(env, post.user.fid, session.id);
      // Persist the cross-quiz completion row (values + bartlet do this; the
      // /quizzes feed reads `quiz_completions`). Best-effort + dedup on
      // (quiz_id, fid) so a re-take from this FID doesn't create dupes.
      try {
        const already = await hasApperceptionCompletion(env, session.fid);
        if (!already) {
          session.completionId = await writeApperceptionCompletion(env, {
            fid: session.fid,
            answers: session.answers,
          });
          await saveSession(env, session);
        }
      } catch (e) {
        console.error('[apperception/snap] writeApperceptionCompletion failed:', e);
      }
      return renderSessionScene(session, origin, mOrigin, env);
    }

    return snapJson(questionSnap(sidParam, session.index, origin));

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[apperception] handler error:', msg);
    return snapJson({ error: 'internal error' }, { status: 500 });
  }
}

// ---------- Session scene routing ----------

async function renderSessionScene(
  session: ApperceptionSession,
  origin: string,
  mOrigin: string,
  env: Env
): Promise<Response> {
  const sid = session.id;

  if (session.index >= APPERCEPTION_LENGTH) {
    const result = freeTierResult(session.answers);
    const airdrop = await resolveAirdrop(session, env);
    return snapJson(resultSnap(sid, result, airdrop, origin, mOrigin));
  }

  return snapJson(questionSnap(sid, session.index, origin));
}

// ---------- Airdrop ----------

async function resolveAirdrop(
  session: ApperceptionSession,
  env: Env
): Promise<AirdropStatus> {
  // Already handled
  if (session.airdropped && session.airdropTxHash) {
    return {
      kind: 'already_claimed',
      txHash: session.airdropTxHash,
    };
  }

  try {
    const outcome = await runApperceptionAirdrop({
      env,
      fid: session.fid,
      sid: session.id,
    });

    // Persist claim
    if (outcome.kind === 'success' || outcome.kind === 'already_claimed') {
      session.airdropped = true;
      if ('txHash' in outcome) session.airdropTxHash = outcome.txHash;
      session.airdropStatus = outcome.kind;
      session.airdropAmountTokens = 'amountTokens' in outcome ? outcome.amountTokens : undefined;
      await saveSession(env, session);
    }

    // Map to snap-friendly status
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
        return {
          kind: 'not_eligible',
          reason: outcome.reason === 'no_address' ? 'no_address' : 'score',
        };
      case 'disabled':
        return { kind: 'disabled' };
      default:
        return { kind: 'pending' };
    }
  } catch (e) {
    console.error('[apperception] airdrop failed:', e);
    return { kind: 'pending' };
  }
}
