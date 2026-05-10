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
 */

import { parseRequest } from '@farcaster/snap/server';
import {
  SNAP_CONTENT_TYPE,
  introSnap,
  questionSnap,
  resultSnap,
  shareSnap,
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
import { freeTierResult, type ValuesAnswer } from '../services/values/scoring';
import { createQuizCompletion } from './quiz-completions';

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

  const parsed = await parseRequest(request, {
    skipJFSVerification: env.SNAP_SKIP_JFS === '1',
  });
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
      return snapJson(shareSnap(shareParam, url.origin));
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
  await saveSession(env, session);

  const free = freeTierResult(session.answers);
  try {
    await createQuizCompletion(env, {
      quizId: 'values',
      userId: session.fid,
      answersJson: JSON.stringify(session.answers),
      scores: { ...free.scores, dominant: free.dominant, secondary: free.secondary },
      resultCategory: free.dominant,
      format: 'quiz', // → 'private' visibility default
    });
  } catch (e) {
    // Non-fatal — don't block the snap response if D1/QStorage hiccups.
    console.error('[values] Failed to create quiz completion:', e);
  }

  return snapJson(resultSnap(session.id, free, url.origin, miniappOrigin(env, url.origin)));
}

function renderSessionScene(
  session: ValuesSession,
  origin: string,
  env: Env
): Response {
  if (session.index >= VALUES_LENGTH) {
    return snapJson(
      resultSnap(
        session.id,
        freeTierResult(session.answers),
        origin,
        miniappOrigin(env, origin)
      )
    );
  }
  return snapJson(questionSnap(session.id, session.index, origin));
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
    if (!Number.isFinite(num)) return null;
    const clamped = Math.max(1, Math.min(5, Math.round(num)));
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

