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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept',
  'Access-Control-Max-Age': '86400',
};

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
      'Cache-Control': 'no-store',
      'Vary': 'Accept',
      ...CORS_HEADERS,
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

/**
 * Load snap vote counts for a question + session.
 * Returns counts keyed by option label (resolved from option_index).
 */
async function loadSnapCounts(
  env: Env,
  questionId: string,
  snapSessionId: string,
  options?: string[]
): Promise<{ counts: Record<string, number>; total: number }> {
  const { results } = await env.DB.prepare(
    `SELECT option_index, COUNT(*) as count FROM answer_snap
     WHERE question_id = ? AND snap_session_id = ?
     GROUP BY option_index`
  ).bind(questionId, snapSessionId).all();

  const counts: Record<string, number> = {};
  let total = 0;
  for (const row of (results || []) as Array<{ option_index: number; count: number }>) {
    const label = options?.[row.option_index] ?? `option_${row.option_index}`;
    counts[label] = row.count;
    total += row.count;
  }
  return { counts, total };
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

  // HEAD request — minimal response so Farcaster's HEAD probe succeeds.
  // parseRequest from @farcaster/snap/server fails on HEAD (no body).
  if (request.method === 'HEAD') {
    return new Response(null, {
      status: 200,
      headers: {
        'Content-Type': SNAP_CONTENT_TYPE,
        'Cache-Control': 'no-store',
        'Vary': 'Accept',
        ...CORS_HEADERS,
      },
    });
  }

  let parsed;
  try {
    parsed = await parseRequest(request, {
      skipJFSVerification: env.SNAP_SKIP_JFS === '1',
    });
  } catch (parseError) {
    console.error('[Snap] parseRequest threw:', parseError);
    return Response.json({ error: 'Failed to parse snap request', detail: String(parseError) }, { status: 400 });
  }

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
    // Load snap vote count for the badge (overrides stale pub_answers).
    const options = parseOptions(query.a_options);
    const snapSessionId = queryId;
    const { total: snapTotal } = await loadSnapCounts(env, queryId, snapSessionId, options);
    const queryWithSnapCount = { ...query, pub_answers: snapTotal || query.pub_answers };
    return snapJson(questionToSnap(queryWithSnapCount, url.origin), {
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

  // Silent vote: write directly to answer_snap (no cast, no answer_meta).
  // One vote per FID per question per session — UPSERT on conflict.
  const snapSessionId = queryId; // v1: canonical session per question

  await env.DB.prepare(
    `INSERT INTO answer_snap (question_id, fid, option_index, snap_session_id)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(question_id, fid, snap_session_id) DO UPDATE SET
       option_index = excluded.option_index,
       updated_at = CURRENT_TIMESTAMP`
  ).bind(queryId, fid, choiceIndex, snapSessionId).run();

  // Refresh counts from answer_snap (includes the just-upserted vote).
  const { counts } = await loadSnapCounts(env, queryId, snapSessionId, options);

  return snapJson(questionResultsToSnap(query, counts, choice, url.origin));
}
