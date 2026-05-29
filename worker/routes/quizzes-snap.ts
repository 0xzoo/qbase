/**
 * /snap/quizzes — index snap for the three Farcaster-snap quizzes.
 *
 * One scene only: a menu that lets the user tap into any of the three quiz
 * snaps without leaving the cast feed. Each button submits to that quiz's
 * `?start=1` URL — same entry point a fresh "Start" tap from the per-quiz
 * intro uses — so the menu is a drop-in replacement for casting the three
 * quizzes side by side.
 *
 * The handler doesn't manage any state itself: the per-quiz routes own
 * session/airdrop/result. We just render the menu and bounce.
 *
 * Wired by `worker/routes/snap.ts` (path match + HTML preview). The HTML
 * representation lives there too (`snapPreviewFor`).
 */

import { parseSnapRequestCompat } from '../services/snapCompat';
import { quizzesIndexSnap, QUIZZES_SNAP_CONTENT_TYPE } from '../services/quizzes/snap';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

export const QUIZZES_PATH = '/snap/quizzes';
// Dev alias — same handler, different path. Lets us iterate without fighting
// Farcaster's snap embed cache.
export const QUIZZES_DEV_PATH = '/snap/quizzes-dev';

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
      'Content-Type': QUIZZES_SNAP_CONTENT_TYPE,
      'Cache-Control': 'private, max-age=0',
      'Vary': 'Accept, X-Snap-Payload',
      ...CORS_HEADERS,
      ...(init.headers || {}),
    },
  });
}

export async function handleQuizzesSnap(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // HEAD probe — mirrors values/apperception. Some snap clients (e.g.
  // Quorum) HEAD the embed before committing to the snap path; replying with
  // an empty 200 keeps the embed resolvable.
  if (request.method === 'HEAD') {
    return new Response(null, {
      status: 200,
      headers: {
        'Content-Type': QUIZZES_SNAP_CONTENT_TYPE,
        'Cache-Control': 'private, max-age=0',
        'Vary': 'Accept, X-Snap-Payload',
        ...CORS_HEADERS,
      },
    });
  }

  const parsed = await parseSnapRequestCompat(request, env);
  if (!parsed.success) {
    console.warn('[quizzes] parseRequest failed:', parsed.error);
    return Response.json({ error: parsed.error }, { status: 400 });
  }

  // Single scene — GET or POST both render the menu. A POST only lands here
  // if a stale snap UI submits back to /snap/quizzes (cache from an older
  // version, etc.); rendering the menu again is the safe no-op.
  return snapJson(quizzesIndexSnap(url.origin));
}
