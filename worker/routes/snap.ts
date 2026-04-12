/**
 * Snap content negotiation + action handling for /question/:id.
 *
 * When a client sends `Accept: application/vnd.farcaster.snap+json`, this
 * route returns a Farcaster Snap JSON representation of the question instead
 * of the SPA HTML. Same URL, two representations.
 *
 * GET   → initial render (questionToSnap)
 * POST  → verified interaction. Body is a JFS, parsed & verified via
 *         @farcaster/snap/server. Currently supports MC vote submission only;
 *         other question types render their read-only preview.
 *
 * Set `SNAP_SKIP_JFS=1` in env to bypass signature verification (local dev only).
 */

import { parseRequest } from '@farcaster/snap/server';
import {
  questionToSnap,
  questionResultsToSnap,
  bartletIntroSnap,
  bartletQuestionSnap,
  bartletResultSnap,
  parseOptions,
  SNAP_CONTENT_TYPE,
  type QueryRow,
} from '../services/SnapService';
import {
  BARTLET_LENGTH,
  applyAnswer,
  readState,
} from '../services/BartletQuiz';
import { BARTLET_PATH, BARTLET_DEV_PATH, handleBartletSnap } from './bartlet';
import { ensureUserExists } from '../middleware/userAutoCreate';
import { handleCreateAnswer } from '../api-bridge';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

const QUESTION_PATH_RE = /^\/question\/([a-zA-Z0-9-]+)\/?$/;
// Legacy dev path — old Bartle quiz kept around until bartlet is live
// so we don't break an existing cast. New quiz lives at /snap/bartlet.
const LEGACY_BARTLET_PATH = '/snap/bartle-dev';

export function isSnapRequest(request: Request): boolean {
  const accept = request.headers.get('Accept') || '';
  return accept.includes('application/vnd.farcaster.snap+json');
}

function snapJson(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: {
      'Content-Type': SNAP_CONTENT_TYPE,
      // Aggressive no-store on POST responses; short TTL on GET initial render
      // is applied by the caller via init.headers override.
      'Cache-Control': 'no-store',
      ...(init.headers || {}),
    },
  });
}

async function loadQuery(env: Env, queryId: string): Promise<QueryRow | null> {
  const row = await env.DB.prepare(
    `SELECT id, stem, type, a_options, pub_answers, coiner_fname
     FROM queries WHERE id = ?`
  ).bind(queryId).first();
  return (row as QueryRow | null) ?? null;
}

async function loadPublicCounts(env: Env, queryId: string): Promise<Record<string, number>> {
  const { results } = await env.DB.prepare(
    `SELECT value, COUNT(*) as count FROM answers
     WHERE q_id = ? AND audience = 'Public'
     GROUP BY value`
  ).bind(queryId).all();

  const counts: Record<string, number> = {};
  for (const row of (results || []) as Array<{ value: string; count: number }>) {
    counts[row.value] = row.count;
  }
  return counts;
}

async function handleLegacyBartletSnap(request: Request, env: Env, url: URL): Promise<Response> {
  const parsed = await parseRequest(request, {
    skipJFSVerification: env.SNAP_SKIP_JFS === '1',
  });
  if (!parsed.success) {
    console.warn('[Snap/Bartlet] parseRequest failed:', parsed.error);
    return Response.json({ error: parsed.error }, { status: 400 });
  }

  const { qi, scores } = readState(url);

  // GET — render whatever scene the URL points at (intro / question / result).
  // This lets shared result URLs render as result cards for other viewers.
  if (parsed.action.type === 'get') {
    if (qi < 0) return snapJson(bartletIntroSnap(url.origin));
    if (qi >= BARTLET_LENGTH) return snapJson(bartletResultSnap(scores, url.origin));
    return snapJson(bartletQuestionSnap(qi, scores, url.origin));
  }

  // POST — advance state.
  // The submit button on question scene N targets a URL with qi=N+1. Scoring
  // applies the choice against question at qi-1 (the one the user just saw).
  const choiceRaw = parsed.action.inputs.choice;
  const choice = typeof choiceRaw === 'string' ? choiceRaw : null;

  // If we're landing on a question scene, the previous scene was either intro
  // (qi=0 target, no scoring) or question qi-1 (apply scoring).
  let nextScores = scores;
  if (qi > 0 && choice) {
    nextScores = applyAnswer(scores, qi - 1, choice);
  }

  if (qi >= BARTLET_LENGTH) {
    return snapJson(bartletResultSnap(nextScores, url.origin));
  }
  if (qi < 0) {
    return snapJson(bartletIntroSnap(url.origin));
  }
  return snapJson(bartletQuestionSnap(qi, nextScores, url.origin));
}

export async function handleSnapRoutes(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);

  // bartlet — the real quiz with $QQ airdrop. See worker/routes/bartlet.ts.
  if (
    url.pathname === BARTLET_PATH ||
    url.pathname === BARTLET_PATH + '/' ||
    url.pathname === BARTLET_DEV_PATH ||
    url.pathname === BARTLET_DEV_PATH + '/'
  ) {
    return handleBartletSnap(request, env);
  }

  // Legacy dev Bartlet quiz: snap-only path, no content negotiation. Kept
  // around until bartlet is live so we don't break an existing cast.
  if (url.pathname === LEGACY_BARTLET_PATH || url.pathname === LEGACY_BARTLET_PATH + '/') {
    return handleLegacyBartletSnap(request, env, url);
  }

  const match = url.pathname.match(QUESTION_PATH_RE);
  if (!match) return null;
  if (!isSnapRequest(request)) return null;

  const queryId = match[1];

  const parsed = await parseRequest(request, {
    skipJFSVerification: env.SNAP_SKIP_JFS === '1',
  });

  if (!parsed.success) {
    console.warn('[Snap] parseRequest failed:', parsed.error);
    return Response.json({ error: parsed.error }, { status: 400 });
  }

  const query = await loadQuery(env, queryId);
  if (!query) {
    return Response.json({ error: 'Question not found' }, { status: 404 });
  }

  // GET — initial render.
  if (parsed.action.type === 'get') {
    return snapJson(questionToSnap(query, url.origin), {
      headers: { 'Cache-Control': 'public, max-age=60' },
    });
  }

  // POST — verified interaction.
  const fid = parsed.action.user.fid;
  const { inputs } = parsed.action;
  const options = parseOptions(query.a_options);
  const choiceRaw = inputs.choice;
  const choice = typeof choiceRaw === 'string' ? choiceRaw : null;

  // Only MC with a valid choice is interactive in this slice; fall back to
  // the initial render for anything else so the client still gets valid JSON.
  if (query.type !== 'mc' || options.length === 0 || !choice || !options.includes(choice)) {
    return snapJson(questionToSnap(query, url.origin));
  }

  const choiceIndex = options.indexOf(choice);

  const userRow = await ensureUserExists(env, fid);
  if (!userRow) {
    console.error('[Snap] ensureUserExists failed for fid', fid);
    return Response.json({ error: 'Failed to resolve user' }, { status: 500 });
  }

  // Reuse handleCreateAnswer so points deduction, vector embedding, and
  // audit logic all live in one place. The synthetic request injects the
  // verified internal user_id directly into the body; handleCreateAnswer
  // doesn't read auth headers.
  const answerBody = {
    user_id: userRow.id,
    q_id: queryId,
    value: choice,
    audience: 'Public',
    answer_type_id: 2, // MC
    answer_data: { index: choiceIndex },
  };

  const syntheticReq = new Request(`${url.origin}/api/answers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(answerBody),
  });

  const createResponse = await handleCreateAnswer(syntheticReq, env);
  if (!createResponse.ok) {
    // 402 Payment Required = insufficient QP. Show results anyway so the UX
    // doesn't dead-end, but log so we can surface this better later.
    const status = createResponse.status;
    console.warn(`[Snap] handleCreateAnswer returned ${status} for fid ${fid} q ${queryId}`);
  }

  // Refresh counts (includes the just-inserted answer if save succeeded).
  const counts = await loadPublicCounts(env, queryId);

  return snapJson(questionResultsToSnap(query, counts, choice, url.origin));
}
