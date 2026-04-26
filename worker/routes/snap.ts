/**
 * Snap endpoints for /snap/question/:id.
 *
 * Dedicated snap URLs — completely separate from the miniapp at /question/:id.
 * No content negotiation needed; the /snap/ path IS the snap representation.
 *
 * GET   → scene 1 (question+options+vote) or scene 2 (results if already voted)
 * POST  → verified interaction → vote recorded → scene 2 (results)
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

const SNAP_QUESTION_RE = /^\/snap\/question\/([a-zA-Z0-9-]+)\/?$/;
const LEGACY_BARTLET_PATH = '/snap/bartle-dev';

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

async function loadQuery(env: Env, queryId: string): Promise<QueryRow | null> {
  const row = await env.DB.prepare(
    `SELECT q.id, q.stem, q.type, q.a_options, q.pub_answers, q.coiner_fname,
            qm.cast_hash, qm.author_fid as caster_fid
     FROM queries q
     LEFT JOIN question_meta qm ON qm.question_id = q.id
     WHERE q.id = ?`
  ).bind(queryId).first();
  return (row as QueryRow | null) ?? null;
}

/**
 * Load snap vote counts for a question + session.
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

/**
 * Check if a FID has already voted on this question+session.
 */
async function getExistingVote(
  env: Env,
  questionId: string,
  fid: number,
  snapSessionId: string,
  options: string[],
): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT option_index FROM answer_snap
     WHERE question_id = ? AND fid = ? AND snap_session_id = ?`
  ).bind(questionId, fid, snapSessionId).first() as { option_index: number } | null;
  if (row && options[row.option_index]) {
    return options[row.option_index];
  }
  return null;
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

  if (parsed.action.type === 'get') {
    if (qi < 0) return snapJson(bartletIntroSnap(url.origin));
    if (qi >= BARTLET_LENGTH) return snapJson(bartletResultSnap(scores, url.origin));
    return snapJson(bartletQuestionSnap(qi, scores, url.origin));
  }

  const choiceRaw = parsed.action.inputs.choice;
  const choice = typeof choiceRaw === 'string' ? choiceRaw : null;

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

  // bartlet
  if (
    url.pathname === BARTLET_PATH ||
    url.pathname === BARTLET_PATH + '/' ||
    url.pathname === BARTLET_DEV_PATH ||
    url.pathname === BARTLET_DEV_PATH + '/'
  ) {
    return handleBartletSnap(request, env);
  }

  // Legacy dev Bartlet quiz
  if (url.pathname === LEGACY_BARTLET_PATH || url.pathname === LEGACY_BARTLET_PATH + '/') {
    return handleLegacyBartletSnap(request, env, url);
  }

  const match = url.pathname.match(SNAP_QUESTION_RE);
  if (!match) return null;

  const queryId = match[1];

  // HEAD request — minimal response so Farcaster's HEAD probe succeeds.
  if (request.method === 'HEAD') {
    return new Response(null, {
      status: 200,
      headers: {
        'Content-Type': SNAP_CONTENT_TYPE,
        'Cache-Control': 'no-store',
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

  const snapSessionId = queryId;
  const options = parseOptions(query.a_options);

  // ── GET — initial render (or results if already voted) ──

  if (parsed.action.type === 'get') {
    // Check if this user has already voted (only if we have a FID from JFS).
    const fid: number | undefined =
      (parsed.action as { user?: { fid?: number } }).user?.fid;

    if (fid && query.type === 'mc' && options.length > 0) {
      const existing = await getExistingVote(env, queryId, fid, snapSessionId, options);
      if (existing) {
        const { counts } = await loadSnapCounts(env, queryId, snapSessionId, options);
        return snapJson(questionResultsToSnap(query, counts, existing, url.origin, true), {
          headers: { 'Cache-Control': 'public, max-age=30' },
        });
      }
    }

    // First-time viewer — show scene 1.
    const { total: snapTotal } = await loadSnapCounts(env, queryId, snapSessionId, options);
    const queryWithSnapCount = { ...query, pub_answers: snapTotal || query.pub_answers };
    return snapJson(questionToSnap(queryWithSnapCount, url.origin), {
      headers: { 'Cache-Control': 'public, max-age=60' },
    });
  }

  // ── POST — verified interaction (vote) ──

  const fid = parsed.action.user.fid;
  const { inputs } = parsed.action;
  const choiceRaw = inputs.choice;
  const choice = typeof choiceRaw === 'string' ? choiceRaw : null;

  if (query.type !== 'mc' || options.length === 0 || !choice || !options.includes(choice)) {
    return snapJson(questionToSnap(query, url.origin));
  }

  const choiceIndex = options.indexOf(choice);

  // UPSERT — one vote per FID per question per session.
  await env.DB.prepare(
    `INSERT INTO answer_snap (question_id, fid, option_index, snap_session_id)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(question_id, fid, snap_session_id) DO UPDATE SET
       option_index = excluded.option_index,
       updated_at = CURRENT_TIMESTAMP`
  ).bind(queryId, fid, choiceIndex, snapSessionId).run();

  const { counts } = await loadSnapCounts(env, queryId, snapSessionId, options);

  return snapJson(questionResultsToSnap(query, counts, choice, url.origin, false));
}
