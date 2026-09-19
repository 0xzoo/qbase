/**
 * Snap endpoints for /snap/question/:id.
 *
 * Dedicated snap URLs. Content-negotiated on `Accept`: a snap client (which
 * sends `Accept: application/vnd.farcaster.snap+json`) gets the snap JSON; a
 * link-preview crawler or browser gets an HTML page carrying OG tags + a `Link`
 * header advertising the snap alternate. Without the HTML representation the
 * cast embed never resolves (`_status: PENDING`) and clients that render from
 * resolved metadata — including Quorum — drop the embed for the bare permalink.
 * See wantsHtmlPreview()/snapPreviewResponse() below.
 *
 * GET   → scene 1 (question+options) by default. When the client attaches a
 *         valid `X-Snap-Payload` JFS header, @farcaster/snap exposes the viewer
 *         FID in `parsed.action.user`; if that viewer has already answered we
 *         skip to scene 2 (results) for mc/scale/checkbox. Anonymous GETs
 *         always see scene 1 (the spec forbids requiring viewer identity).
 * POST  → verified interaction → answer recorded → scene 2 (results)
 *
 * Set `SNAP_SKIP_JFS=1` in env to bypass signature verification (local dev only).
 */

import { parseSnapRequestCompat } from '../services/snapCompat';
import {
  questionToSnap,
  mcQuestionToSnapPaged,
  questionToSnapCompact,
  stripStemFromSnap,
  questionResultsToSnap,
  scaleResultsToSnap,
  textSubmittedToSnap,
  lowScoreSnap,
  checkboxResultsToSnap,
  resolveScaleConfig,
  bartletIntroSnap,
  bartletQuestionSnap,
  bartletResultSnap,
  mcWriteInToSnap,
  parseOptions,
  verifyCompactToken,
  SNAP_CONTENT_TYPE,
  type QueryRow,
  type ScaleConfig,
  type SnapResponse,
  lockedSnap,
  snapBase,
} from '../services/SnapService';
import {
  parseOptionsConfig,
  listVisibleOptions,
  addOrVoteWriteIn,
  recordMcVote,
  type OptionsConfig,
} from '../services/PollOptionsService';
import { RateLimitService } from '../services/RateLimitService';
import {
  BARTLET_LENGTH,
  applyAnswer,
  readState,
} from '../services/BartletQuiz';
import { BARTLET_PATH, BARTLET_DEV_PATH, handleBartletSnap } from './bartlet';
import { VALUES_PATH, VALUES_DEV_PATH, handleValuesSnap } from './values';
import { APPERCEPTION_PATH, APPERCEPTION_DEV_PATH, handleApperceptionSnap } from './apperception';
import { CA_SLATE_PATH, CA_SLATE_DEV_PATH, handleCaSlateSnap } from './ca-slate';
import { QUIZZES_PATH, QUIZZES_DEV_PATH, handleQuizzesSnap } from './quizzes-snap';
import { initCastRouter } from '../services/casting';
import { getMcCounts, getCheckboxCounts, getScaleCounts, getExistingAnswer } from '../services/AnswerCountService';
import { getCachedNeynarUser } from '../services/NeynarUserService';
import { initFarcasterData } from '../services/farcaster';
import { EligibilityService, type EligibilityReason } from '../services/EligibilityService';
import { getOpenPoll, getPoll, type PollRow } from '../services/PollService';
import { coerceTalliedAudience, resolveStickyAudience } from '../services/AudienceService';
import { anonTag } from '../services/anon/AnonTag';
import { anonWriteFor } from '../services/AnonAttributionService';
import { MetaService } from '../services/MetaService';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, X-Snap-Payload',
  'Access-Control-Max-Age': '86400',
};

const SNAP_QUESTION_RE = /^\/snap\/question\/([a-zA-Z0-9_-]+)\/?$/;
/** A wave's own snap URL: every answer through it is attributed to the wave. */
const SNAP_POLL_RE = /^\/snap\/poll\/([a-zA-Z0-9_-]+)\/?$/;
const LEGACY_BARTLET_PATH = '/snap/bartle-dev';

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

// ─── Content negotiation (HTML preview ↔ snap JSON) ───────────────────────
//
// A snap URL serves two representations of the same resource, negotiated on
// `Accept` — exactly like Farcaster's reference snap (snap-kitchen-sink):
//
//   • `Accept: application/vnd.farcaster.snap+json`  → snap JSON (what a snap
//     client requests once it discovers the snap via the Link header)
//   • anything else (no Accept, `*/*`, `text/html`)  → an HTML page with OG
//     tags + a `Link` header advertising the snap alternate
//
// The HTML representation is what link-preview crawlers (Neynar) fetch when a
// cast embeds the URL. Serving them snap JSON leaves the embed stuck at
// `_status: PENDING` (nothing to resolve), so clients that render from resolved
// metadata — including Quorum — drop the embed and show only the bare permalink.
// HTML is therefore the default; snap JSON is gated on the explicit snap Accept
// (or an `X-Snap-Payload` personalized GET).

/** True when this is a plain GET that should receive the HTML preview. */
function wantsHtmlPreview(request: Request): boolean {
  if (request.method !== 'GET') return false; // POST/HEAD/OPTIONS are snap-protocol
  const accept = request.headers.get('Accept') || '';
  if (accept.includes(SNAP_CONTENT_TYPE)) return false; // snap client
  if (request.headers.has('X-Snap-Payload')) return false; // personalized snap GET
  return true;
}

interface SnapPreview {
  title: string;
  description: string;
  image: string;
  /** fc:miniapp launch URL — only set when a real mini-app route backs the snap. */
  miniappUrl?: string;
  miniappButton?: string;
}

/** Map a snap pathname to its link-preview metadata, or null if unknown. */
async function snapPreviewFor(env: Env, url: URL): Promise<SnapPreview | null> {
  const p = url.pathname.replace(/\/$/, '');
  const o = url.origin;

  if (p === VALUES_PATH || p === VALUES_DEV_PATH) {
    return {
      title: 'values',
      description: 'find your moral shape — autonomy, care, openness, mastery, universalism. by @qbase',
      image: `${o}/r2/values/intro.png`,
    };
  }
  if (p === BARTLET_PATH || p === BARTLET_DEV_PATH || p === LEGACY_BARTLET_PATH) {
    return {
      title: 'bartlet',
      description: 'find your Farcaster archetype — by @qbase',
      image: `${o}/r2/bartlet/intro.png`,
    };
  }
  if (p === APPERCEPTION_PATH || p === APPERCEPTION_DEV_PATH) {
    return {
      title: 'app·erception',
      description: 'find your cognitive style — some self-assembly required. by @qbase',
      image: `${o}/r2/apperception/intro-v2.png`,
    };
  }
  if (p === CA_SLATE_PATH || p === CA_SLATE_DEV_PATH) {
    return {
      title: 'ca slate',
      description:
        'your picks across 8 california statewide offices — governor, ag, treasurer, and more. 13 questions, sourced from public positions. by @qbase',
      image: `${o}/questions.png`,
    };
  }
  if (p === QUIZZES_PATH || p === QUIZZES_DEV_PATH) {
    return {
      title: 'quizzes',
      description: 'three short quizzes from @qbase — apperception, values, bartlet',
      image: `${o}/questions.png`,
    };
  }
  const pm = url.pathname.match(SNAP_POLL_RE);
  const m = url.pathname.match(SNAP_QUESTION_RE);
  if (pm || m) {
    let id = m ? m[1] : '';
    if (pm) {
      const poll = await getPoll(env.DB, pm[1]);
      if (!poll) return null;
      id = poll.question_id;
    }
    // No fc:miniapp here — Farcaster prefers it over the snap Link header and
    // would render a mini-app embed instead of the snap. OG + Link only, same as
    // the quiz snaps, so the cast embed renders as a native snap.
    return {
      title: 'qbase',
      description: 'answer in-feed on qbase',
      image: `${o}/api/og/question/${id}`,
    };
  }
  return null;
}

function escapeHtmlAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Build the HTML representation of a snap URL: index.html with OG tags (and an
 * fc:miniapp tag when a mini-app backs the snap) injected, plus a `Link` header
 * pointing back to this same URL as the snap alternate so a discovering client
 * refetches it with the snap Accept header (preserving ?compact / ?sid / ?share).
 */
async function snapPreviewResponse(env: Env, url: URL, preview: SnapPreview): Promise<Response> {
  const selfUrl = `${url.origin}${url.pathname}${url.search}`;
  const e = escapeHtmlAttr;

  const tags = [
    `<meta property="og:type" content="website" />`,
    `<meta property="og:title" content="${e(preview.title)}" />`,
    `<meta property="og:description" content="${e(preview.description)}" />`,
    `<meta property="og:image" content="${e(preview.image)}" />`,
    `<meta property="og:url" content="${e(selfUrl)}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:image" content="${e(preview.image)}" />`,
    preview.miniappUrl
      ? MetaService.generateMiniAppTag(preview.image, preview.miniappButton || 'Open', preview.miniappUrl)
      : '',
  ].join('');

  let html = '<!doctype html><html><head></head><body></body></html>';
  try {
    const indexReq = new Request(new URL('/index.html', url.origin).toString(), { method: 'GET' });
    const indexRes = await env.ASSETS.fetch(indexReq);
    if (indexRes.ok) html = await indexRes.text();
  } catch (err) {
    console.error('[Snap] index.html fetch failed for preview, using minimal shell:', err);
  }

  // Discovery Link header. Use a RELATIVE ref (resolved by the client against
  // the request URL) and advertise both representations of this same resource —
  // matching the spec example and Farcaster's reference snap (snap-kitchen-sink).
  // An absolute URL or a missing text/html alternate stops some client parsers
  // from recognising the content-negotiated snap, so they fall back to the OG
  // card. The ref preserves ?compact&token / ?sid / ?share.
  const ref = `${url.pathname}${url.search}`;
  const linkHeader =
    `<${ref}>; rel="alternate"; type="${SNAP_CONTENT_TYPE}", ` +
    `<${ref}>; rel="alternate"; type="text/html"`;

  return new Response(MetaService.injectTags(html, tags), {
    status: 200,
    headers: {
      'Content-Type': 'text/html;charset=UTF-8',
      // max-age=0 (revalidate every fetch) keeps the embed cache from serving a
      // stale representation while iterating, mirroring the reference snap.
      'Cache-Control': 'public, max-age=0, must-revalidate',
      'Vary': 'Accept, X-Snap-Payload',
      'Link': linkHeader,
      ...CORS_HEADERS,
    },
  });
}

async function loadQuery(env: Env, queryId: string): Promise<QueryRow | null> {
  const row = await env.DB.prepare(
    `SELECT q.id, q.stem, q.type, q.a_options, q.scale_config, q.pub_answers, q.coiner_fname,
            qm.cast_hash, qm.author_fid as caster_fid
     FROM queries q
     LEFT JOIN question_meta qm ON qm.question_id = q.id
     WHERE q.id = ?`
  ).bind(queryId).first();
  return (row as QueryRow | null) ?? null;
}

/**
 * Ensure a user exists in the Users table for a given FID.
 * After the fid-as-PK migration, fid IS the user_id — no resolution needed.
 *
 * On first creation, fetches the real profile from Neynar so we don't end up
 * with placeholder "user-{fid}" display names (see snap.ts historical bug).
 */
async function ensureUserByFid(env: Env, fid: number): Promise<boolean> {
  const existing = await env.DB.prepare('SELECT fid FROM Users WHERE fid = ?').bind(fid).first();
  if (existing) return true;

  // Fetch the real profile (Neynar → hub) before creating
  let fname = `user-${fid}`; // fallback if no provider answers
  let displayName: string | null = null;
  let pfpUrl: string | null = null;

  try {
    const fcUser = await initFarcasterData(env).getUser(fid);
    if (fcUser) {
      fname = fcUser.username || fname;
      displayName = fcUser.display_name || null;
      pfpUrl = fcUser.pfp_url || null;
    }
  } catch (err) {
    console.error('[Snap] profile fetch failed, using fallback fname:', err);
  }

  try {
    await env.DB.prepare(
      'INSERT INTO Users (fid, fname, display_name, pfp_url) VALUES (?, ?, ?, ?)',
    ).bind(fid, fname, displayName, pfpUrl).run();
    console.log(`[Snap] Created user ${fname} (FID: ${fid})`);
    return true;
  } catch {
    // Race condition: another request created it
    const retry = await env.DB.prepare('SELECT fid FROM Users WHERE fid = ?').bind(fid).first();
    return !!retry;
  }
}

/**
 * Load MC snap answer counts from the unified Answers table.
 * Uses the shared CTE-based count that only counts each user's latest answer.
 */
async function loadSnapCounts(
  env: Env,
  query: QueryRow,
): Promise<{ counts: Record<string, number>; total: number }> {
  return getMcCounts(env.DB, query.id, query.poll_id ?? null);
}

function lockReasonText(reason: EligibilityReason): string {
  return reason === 'closed' ? 'Voting closed'
    : reason === 'not_holder' ? 'Holders only'
    : 'Voting locked';
}

/**
 * Locked results scene for any question type — the aggregate with the lock
 * reason where the "you answered" line would be. Text (and anything without
 * a resolvable results scene) gets the generic locked card.
 */
async function renderLockedScene(
  env: Env,
  query: QueryRow,
  reasonText: string,
  origin: string,
): Promise<SnapResponse> {
  if (query.type === 'mc') {
    const { counts } = await loadSnapCounts(env, query);
    const openCfg = query.poll_id ? parseOptionsConfig(query.options_config) : null;
    const orderedLabels = openCfg && query.poll_id
      ? (await listVisibleOptions(env.DB, query.poll_id)).map(o => o.label)
      : undefined;
    return questionResultsToSnap(query, counts, '', origin, false, reasonText, orderedLabels);
  }
  if (query.type === 'scale' || query.type === 'scale_range') {
    const config = resolveScaleConfig(query);
    if (config) return buildScaleResults(env, query, config, 0, origin, false, reasonText);
  }
  if (query.type === 'checkbox') {
    return buildCheckboxResults(env, query, [], origin, reasonText);
  }
  return lockedSnap(query, reasonText, origin);
}

/**
 * Render an open-options poll's question scene from its live poll_options set.
 * Always uses the paged renderer so the "➕ Add your own" CTA shows (hidden at
 * cap). Compact mode strips the stem.
 */
async function renderOpenMcScene(
  env: Env,
  query: QueryRow,
  cfg: OptionsConfig,
  url: URL,
  compactSuffix: string,
): Promise<SnapResponse> {
  const labels = (await listVisibleOptions(env.DB, query.poll_id as string)).map(o => o.label);
  const atCap = labels.length >= cfg.cap;
  const page = parseInt(url.searchParams.get('page') || '1', 10);
  const scene = mcQuestionToSnapPaged(query, labels, url.origin, page, compactSuffix, { atCap });
  return compactSuffix ? stripStemFromSnap(scene) : scene;
}

/**
 * POST handler for open-options polls: the write-in input scene, the write-in
 * submit (add/merge + vote), pagination re-renders, and normal option votes.
 * Votes go through the shared append-only path so counts stay consistent with
 * closed MC.
 */
async function handleOpenMcPost(
  env: Env,
  query: QueryRow,
  fid: number,
  inputs: Record<string, unknown>,
  url: URL,
  audience: 'Public' | 'Anon',
  compactSuffix: string,
  cfg: OptionsConfig,
  poll: PollRow,
): Promise<Response> {
  const queryId = query.id;
  const pollId = poll.id;
  const writein = url.searchParams.get('writein');

  const renderOptions = async (): Promise<Response> => {
    const labels = (await listVisibleOptions(env.DB, poll.id)).map(o => o.label);
    const atCap = labels.length >= cfg.cap;
    const page = parseInt(url.searchParams.get('page') || '1', 10);
    const scene = mcQuestionToSnapPaged(query, labels, url.origin, page, compactSuffix, { atCap });
    return snapJson(compactSuffix ? stripStemFromSnap(scene) : scene);
  };

  const renderResults = async (choice: string): Promise<Response> => {
    const { counts } = await loadSnapCounts(env, query);
    const labels = (await listVisibleOptions(env.DB, poll.id)).map(o => o.label);
    return snapJson(questionResultsToSnap(query, counts, choice, url.origin, false, undefined, labels));
  };

  // "➕ Add your own" → show the write-in input scene (unless at cap).
  if (writein === '1') {
    const count = (await listVisibleOptions(env.DB, poll.id)).length;
    if (count >= cfg.cap) return renderOptions();
    const scene = mcWriteInToSnap(query, url.origin, compactSuffix, audience);
    return snapJson(compactSuffix ? stripStemFromSnap(scene) : scene);
  }

  // Write-in submit → add/merge the option + record the submitter's vote.
  if (writein === 'submit') {
    const rawLabel = typeof inputs.writein_label === 'string' ? inputs.writein_label : '';
    const rl = RateLimitService.fromEnv(env);
    const allowed = await rl.checkLimit(`fid:${fid}`, 5, 60, 'snap:writein');
    if (!allowed) return renderOptions();
    await ensureUserByFid(env, fid);
    const result = await addOrVoteWriteIn(env, poll, fid, rawLabel, audience);
    if (!result.ok) return renderOptions();
    return renderResults(result.option.label);
  }

  // Pagination re-render (page param, no choice).
  const pageParam = url.searchParams.get('page');
  const urlChoice = url.searchParams.get('choice');
  const choice = urlChoice || (typeof inputs.choice === 'string' ? inputs.choice : null);
  if (pageParam && !choice) return renderOptions();

  // Normal vote — only on a currently-visible option.
  const labels = (await listVisibleOptions(env.DB, poll.id)).map(o => o.label);
  if (!choice || !labels.includes(choice)) return renderOptions();

  await ensureUserByFid(env, fid);
  await recordMcVote(env, queryId, fid, choice, audience, pollId);
  return renderResults(choice);
}

/**
 * If the viewer has already answered, return the appropriate scene-2 results
 * snap. Returns null for text questions (no "already answered" scene exists)
 * and when there's no prior answer of the matching type.
 */
async function maybeRenderPersonalizedResults(
  env: Env,
  query: QueryRow,
  fid: number,
  origin: string,
): Promise<SnapResponse | null> {
  if (query.type === 'mc') {
    const existing = await getExistingAnswer(env.DB, query.id, fid, 2, query.poll_id);
    if (!existing?.value) return null;
    const { counts } = await loadSnapCounts(env, query);
    const cfg = query.poll_id ? parseOptionsConfig(query.options_config) : null;
    const orderedLabels = cfg && query.poll_id
      ? (await listVisibleOptions(env.DB, query.poll_id)).map(o => o.label)
      : undefined;
    return questionResultsToSnap(query, counts, existing.value, origin, true, undefined, orderedLabels);
  }

  if (query.type === 'scale' || query.type === 'scale_range') {
    const existing = await getExistingAnswer(env.DB, query.id, fid, 3, query.poll_id);
    if (!existing?.value) return null;
    const config = resolveScaleConfig(query);
    if (!config) return null;
    const value = parseFloat(existing.value);
    if (!Number.isFinite(value)) return null;
    return buildScaleResults(env, query, config, value, origin, true);
  }

  if (query.type === 'checkbox') {
    const existing = await getExistingAnswer(env.DB, query.id, fid, 4, query.poll_id);
    if (!existing) return null;
    const opts = parseOptions(query.a_options);
    const selected = parseCheckboxSelections(existing.value, existing.answer_data, opts);
    if (selected.length === 0) return null;
    return buildCheckboxResults(env, query, selected, origin);
  }

  return null;
}

function parseCheckboxSelections(
  value: string | null,
  answerData: string | null,
  options: string[],
): string[] {
  if (answerData) {
    try {
      const parsed = JSON.parse(answerData) as { indices?: number[] };
      if (Array.isArray(parsed.indices)) {
        return parsed.indices
          .map(i => options[i])
          .filter((v): v is string => typeof v === 'string');
      }
    } catch {
      // fall through to value-based parsing
    }
  }
  return value ? value.split(', ').filter(s => options.includes(s)) : [];
}

async function handleLegacyBartletSnap(request: Request, env: Env, url: URL): Promise<Response> {
  const parsed = await parseSnapRequestCompat(request, env);
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

export async function handleSnapRoutes(request: Request, env: Env, ctx?: { waitUntil: (p: Promise<any>) => void }): Promise<Response | null> {
  const url = new URL(request.url);

  // Content negotiation: a plain GET (crawler/browser, no snap Accept header)
  // gets the HTML preview — OG tags + a Link header to the snap alternate — so
  // the cast embed resolves and snap clients can discover the snap. Snap clients
  // send `Accept: application/vnd.farcaster.snap+json` and fall through to the
  // JSON handlers below. Only fires for known snap paths (else preview is null).
  if (wantsHtmlPreview(request)) {
    const preview = await snapPreviewFor(env, url);
    if (preview) return snapPreviewResponse(env, url, preview);
  }

  // bartlet
  if (
    url.pathname === BARTLET_PATH ||
    url.pathname === BARTLET_PATH + '/' ||
    url.pathname === BARTLET_DEV_PATH ||
    url.pathname === BARTLET_DEV_PATH + '/'
  ) {
    return handleBartletSnap(request, env);
  }

  // values
  if (
    url.pathname === VALUES_PATH ||
    url.pathname === VALUES_PATH + '/' ||
    url.pathname === VALUES_DEV_PATH ||
    url.pathname === VALUES_DEV_PATH + '/'
  ) {
    return handleValuesSnap(request, env);
  }

  // apperception
  if (
    url.pathname === APPERCEPTION_PATH ||
    url.pathname === APPERCEPTION_PATH + '/' ||
    url.pathname === APPERCEPTION_DEV_PATH ||
    url.pathname === APPERCEPTION_DEV_PATH + '/'
  ) {
    return handleApperceptionSnap(request, env);
  }

  // ca-slate
  if (
    url.pathname === CA_SLATE_PATH ||
    url.pathname === CA_SLATE_PATH + '/' ||
    url.pathname === CA_SLATE_DEV_PATH ||
    url.pathname === CA_SLATE_DEV_PATH + '/'
  ) {
    return handleCaSlateSnap(request, env);
  }

  // quizzes index — menu snap that fans out to apperception/values/bartlet
  if (
    url.pathname === QUIZZES_PATH ||
    url.pathname === QUIZZES_PATH + '/' ||
    url.pathname === QUIZZES_DEV_PATH ||
    url.pathname === QUIZZES_DEV_PATH + '/'
  ) {
    return handleQuizzesSnap(request, env);
  }

  // Legacy dev Bartlet quiz
  if (url.pathname === LEGACY_BARTLET_PATH || url.pathname === LEGACY_BARTLET_PATH + '/') {
    return handleLegacyBartletSnap(request, env, url);
  }

  const questionMatch = url.pathname.match(SNAP_QUESTION_RE);
  const pollMatch = url.pathname.match(SNAP_POLL_RE);
  if (!questionMatch && !pollMatch) return null;

  // CORS preflight — the Farcaster web client fetches cross-origin and sends
  // X-Snap-Payload, which is a custom header that triggers a preflight.
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // HEAD request — minimal response so Farcaster's HEAD probe succeeds.
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
  } catch (parseError) {
    console.error('[Snap] parseRequest threw:', parseError);
    return Response.json({ error: 'Failed to parse snap request', detail: String(parseError) }, { status: 400 });
  }

  if (!parsed.success) {
    console.warn('[Snap] parseRequest failed:', parsed.error);
    return Response.json({ error: parsed.error }, { status: 400 });
  }

  // The wave this snap answers through:
  //   /snap/poll/:id     — that wave, open or closed (its cast is the wave's
  //                        surface; after close it shows locked results).
  //   /snap/question/:id — the question's open wave while one is live (the
  //                        cast is the natural place to answer it), else the
  //                        question itself: always open, poll_id NULL.
  let poll: PollRow | null = null;
  if (pollMatch) {
    poll = await getPoll(env.DB, pollMatch[1]);
    if (!poll) return Response.json({ error: 'Poll not found' }, { status: 404 });
  }
  const queryId = poll ? poll.question_id : (questionMatch as RegExpMatchArray)[1];
  const query = await loadQuery(env, queryId);
  if (!query) {
    return Response.json({ error: 'Question not found' }, { status: 404 });
  }
  if (!poll) poll = await getOpenPoll(env.DB, queryId);
  const pollId = poll?.id ?? null;
  if (pollMatch && poll) query.snap_path = `/snap/poll/${poll.id}`;
  // Compact-mode HMAC is scoped to the surface the cast embedded.
  const compactSubject = pollMatch && poll ? `poll:${poll.id}` : queryId;
  // Wave context rides on the row: tallies, existing-answer checks and the
  // open-options set are all scoped to it (Track A3/A5).
  query.poll_id = pollId;
  query.options_config = poll?.options_config ?? null;

  const options = parseOptions(query.a_options);

  // Open-options poll? (MC-only.) When set, the live option set lives in
  // poll_options, not a_options, and write-ins are accepted.
  const openCfg: OptionsConfig | null =
    poll && query.type === 'mc' ? parseOptionsConfig(query.options_config) : null;

  // ── GET — scene 1 (question) by default; scene 2 (results) if the viewer
  //         FID is known via X-Snap-Payload AND they already answered.

  if (parsed.action.type === 'get') {
    const viewerFid = parsed.action.user?.fid;

    const snapTotal = query.type === 'scale' || query.type === 'scale_range'
      ? (await getScaleCounts(env.DB, queryId, query.poll_id)).total
      : (await loadSnapCounts(env, query)).total;
    const queryWithSnapCount = { ...query, pub_answers: snapTotal || query.pub_answers };

    // Wave lock: closes_at past or snapshot-ineligible on the current wave.
    // Type-agnostic — every question type renders its locked results scene.
    if (poll) {
      const elig = await EligibilityService.check(env, poll, viewerFid ?? -1);
      // A viewer we can't identify isn't "not a holder" — render the question
      // and let the verified POST decide. Time locks apply to everyone.
      const unknownViewerOnGate = !viewerFid && elig.reason === 'not_holder';
      if (!elig.eligible && !unknownViewerOnGate) {
        return snapJson(await renderLockedScene(env, queryWithSnapCount, lockReasonText(elig.reason), url.origin));
      }
    }

    // Viewer-aware short-circuit: mc/scale/checkbox only. Text is excluded
    // because there's no clean "already answered" scene for free-text input.
    if (viewerFid) {
      const personalized = await maybeRenderPersonalizedResults(
        env, queryWithSnapCount, viewerFid, url.origin,
      );
      if (personalized) return snapJson(personalized);
    }

    // Open-options poll: render the live option set from poll_options, always
    // via the paged renderer so the "➕ Add your own" CTA is present.
    if (openCfg) {
      let suffix = '';
      const compact = url.searchParams.get('compact') === '1';
      const token = url.searchParams.get('token') || '';
      if (compact && env.QBASE_SECRET && await verifyCompactToken(compactSubject, token, env.QBASE_SECRET)) {
        suffix = `&compact=1&token=${encodeURIComponent(token)}`;
      }
      return snapJson(await renderOpenMcScene(env, queryWithSnapCount, openCfg, url, suffix));
    }

    // Compact mode: answer input only, no question stem. HMAC-gated to qbase-created casts.
    const compact = url.searchParams.get('compact') === '1';
    const token = url.searchParams.get('token') || '';
    if (compact && env.QBASE_SECRET) {
      const valid = await verifyCompactToken(compactSubject, token, env.QBASE_SECRET);
      if (valid) {
        const compactSuffix = `&compact=1&token=${encodeURIComponent(token)}`;
        // Compact + paginated MC: strip stem from paginated scene
        if (query.type === 'mc' && options.length > 6) {
          const page = parseInt(url.searchParams.get('page') || '1', 10);
          const paged = mcQuestionToSnapPaged(queryWithSnapCount, options, url.origin, page, compactSuffix);
          return snapJson(stripStemFromSnap(paged));
        }
        return snapJson(questionToSnapCompact(queryWithSnapCount, url.origin));
      }
      // Invalid/missing token → serve full snap (silent fallback)
    }

    // MC pagination: read ?page=N for questions with >6 options
    if (query.type === 'mc' && options.length > 6) {
      const page = parseInt(url.searchParams.get('page') || '1', 10);
      return snapJson(mcQuestionToSnapPaged(queryWithSnapCount, options, url.origin, page));
    }

    return snapJson(questionToSnap(queryWithSnapCount, url.origin));
  }

  // ── POST — verified interaction ──

  const fid = parsed.action.user.fid;
  const inputs = parsed.action.inputs;
  console.log(`[Snap/POST] queryId=${queryId} type=${query.type}`);

  // Wave lock: reject ineligible POSTs before any write. Mirrors the GET
  // lock so a viewer who somehow submits past the lock (stale UI, race)
  // gets the locked results scene instead of a vote landing. The real FID
  // is checked even when the answer will be stored anon.
  if (poll) {
    const elig = await EligibilityService.check(env, poll, fid);
    if (!elig.eligible) {
      return snapJson(await renderLockedScene(env, query, lockReasonText(elig.reason), url.origin));
    }
  }

  try {

  // ── MC question — write to Answers + answer_meta ──
  if (query.type === 'mc') {
    // Audience: the toggle_group input, or the write-in scene's carried value.
    // Sticky per wave — the person's first tallied answer here decides.
    const requestedAudience = coerceTalliedAudience(url.searchParams.get('audience') ?? inputs.audience);
    const authorTag = await anonTag(env, fid, queryId);
    const { audience } = await resolveStickyAudience(env.DB, queryId, fid, pollId, requestedAudience, authorTag);
    const privacyTier = audience === 'Anon' ? 'anon' : 'public';

    // Detect compact params from the incoming URL (carried through pagination)
    const openCompactParam = url.searchParams.get('compact');
    const openTokenParam = url.searchParams.get('token') || '';
    const openCompactSuffix = openCompactParam === '1' && openTokenParam
      ? `&compact=1&token=${encodeURIComponent(openTokenParam)}` : '';

    // Open-options wave → dedicated handler (write-in scene, dedup, vote).
    if (openCfg && poll) {
      return handleOpenMcPost(
        env, query, fid, inputs, url,
        audience,
        openCompactSuffix, openCfg, poll,
      );
    }

    // Pagination: POST from "Next/Back" button has ?page=N but no choice
    const pageParam = url.searchParams.get('page');
    const urlChoice = url.searchParams.get('choice');
    const choice = urlChoice ||
      (typeof inputs.choice === 'string' ? inputs.choice : null);

    // Detect compact params from the incoming URL (carried through pagination)
    const compactParam = url.searchParams.get('compact');
    const tokenParam = url.searchParams.get('token') || '';
    const compactSuffix = compactParam === '1' && tokenParam
      ? `&compact=1&token=${encodeURIComponent(tokenParam)}` : '';

    // If page param present but no choice → re-render paginated page
    if (pageParam && !choice) {
      const page = parseInt(pageParam, 10);
      const mcOptions = parseOptions(query.a_options);
      const paged = mcQuestionToSnapPaged(query, mcOptions, url.origin, page, compactSuffix);
      return snapJson(compactSuffix ? stripStemFromSnap(paged) : paged);
    }

    if (options.length === 0 || !choice || !options.includes(choice)) {
      // Fallback: if >6 options, render paginated page 1
      if (options.length > 6) {
        const paged = mcQuestionToSnapPaged(query, options, url.origin, 1, compactSuffix);
        return snapJson(compactSuffix ? stripStemFromSnap(paged) : paged);
      }
      const full = questionToSnap(query, url.origin);
      return snapJson(compactSuffix ? stripStemFromSnap(full) : full);
    }

    // Ensure user exists in Users table
    await ensureUserByFid(env, fid);

    // Append-only: always INSERT a new row. Latest row per user is canonical.
    const answerId = crypto.randomUUID();
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();

    // Only increment pub_answers if this is the user's first MC answer for this question
    const existing = await getExistingAnswer(env.DB, queryId, fid, 2, undefined, authorTag);
    // An Anon row carries the placeholder; its sealed attribution lands in the same batch.
    const anon = await anonWriteFor(env, { fid, audience, answerId, qId: queryId, createdAt: nowIso });

    const batch = [
      env.DB.prepare(
        `INSERT INTO Answers (id, q_id, user_id, value, answer_type_id, audience, created_at, poll_id)
         VALUES (?, ?, ?, ?, 2, ?, ?, ?)`
      ).bind(answerId, queryId, anon.rowFid, choice, audience, nowIso, pollId),
      env.DB.prepare(
        `INSERT INTO answer_meta (id, question_id, responder_fid, privacy_tier, primary_value, pending, created_at)
         VALUES (?, ?, ?, ?, ?, 0, ?)`
      ).bind(answerId, queryId, anon.rowFid, privacyTier, choice, nowMs),
      ...(anon.statement ? [anon.statement] : []),
    ];

    if (!existing) {
      batch.push(
        env.DB.prepare(
          `UPDATE queries SET pub_answers = pub_answers + 1 WHERE id = ?`
        ).bind(queryId),
      );
    }

    await env.DB.batch(batch);

    // Load counts from Answers table (unified storage)
    const { counts } = await loadSnapCounts(env, query);
    return snapJson(questionResultsToSnap(query, counts, choice, url.origin, false));
  }

  // ── Scale — slider value → answers table ──
  if (query.type === 'scale') {
    return handleScaleSnapAnswer(env, query, fid, inputs, url, pollId);
  }

  // ── Text — text input → answers table → @4n0n cast ──
  if (query.type === 'text') {
    return handleTextSnapAnswer(env, query, fid, inputs, url, pollId, ctx);
  }

  // ── Checkbox — toggle selections → answers table ──
  if (query.type === 'checkbox') {
    if (options.length > 6) {
      return snapJson(questionToSnap(query, url.origin));
    }
    return handleCheckboxSnapAnswer(env, query, fid, inputs, url, options, pollId);
  }

  // Fallback: show question scene
  return snapJson(questionToSnap(query, url.origin));

  } catch (postError) {
    console.error(`[Snap/POST] Uncaught error for queryId=${queryId}:`, postError);
    // Return a snap that shows the error
    return snapJson({
      version: '2.0',
      ui: {
        type: 'stack',
        props: { direction: 'vertical', gap: 'md', padding: 'lg' },
        children: ['err_text', 'back_btn'],
        elements: {
          err_text: { type: 'text', props: { content: `Error: ${postError instanceof Error ? postError.message : String(postError)}`, color: 'red' } },
          back_btn: { type: 'button', props: { label: 'Try again', variant: 'secondary' }, on: { press: { action: 'submit', params: { target: snapBase(query, url.origin) } } } },
        },
      },
    });
  }
}

// ─── Scale answer handler ─────────────────────────────────────────────────

async function handleScaleSnapAnswer(
  env: Env,
  query: QueryRow,
  fid: number,
  inputs: Record<string, unknown>,
  url: URL,
  pollId: string | null,
): Promise<Response> {
  const config = resolveScaleConfig(query);
  if (!config) return snapJson(questionToSnap(query, url.origin));

  // Audience from the toggle_group, sticky per wave (first tallied answer decides).
  const authorTag = await anonTag(env, fid, query.id);
  const { audience } = await resolveStickyAudience(
    env.DB, query.id, fid, query.poll_id ?? null, coerceTalliedAudience(inputs.audience), authorTag,
  );
  const privacyTier = audience === 'Anon' ? 'anon' : 'public';

  // No dedup for scale questions — re-submitting just appends a new row.
  // Note: scale dedup actually worked (slider value preserved in confirm_new/keep_old
  // button actions), but removed for consistency with text/checkbox.

  // Read slider value — use default (midpoint) if user didn't interact
  const rawValue = inputs.value;
  const parsedValue = typeof rawValue === 'string' ? parseFloat(rawValue) : Number(rawValue);
  const value = Number.isFinite(parsedValue)
    ? parsedValue
    : Math.round((config.min + config.max) / 2);
  console.log(`[Snap/Scale] rawValue=${rawValue} type=${typeof rawValue} parsedValue=${parsedValue} value=${value} config=`, JSON.stringify(config));
  if (value < config.min || value > config.max) {
    console.warn(`[Snap/Scale] Value rejected: ${value} not in [${config.min}, ${config.max}]`);
    return snapJson(questionToSnap(query, url.origin));
  }

  // Ensure user exists in Users table (fid IS user_id after migration)
  await ensureUserByFid(env, fid);

  // Append-only: always INSERT. Only increment pub_answers on first scale answer.
  const existing = await getExistingAnswer(env.DB, query.id, fid, 3, undefined, authorTag);

  const answerId = crypto.randomUUID();
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const anon = await anonWriteFor(env, { fid, audience, answerId, qId: query.id, createdAt: nowIso });

  const batch = [
    env.DB.prepare(
      `INSERT INTO Answers (id, q_id, user_id, value, answer_type_id, audience, created_at, poll_id)
       VALUES (?, ?, ?, ?, 3, ?, ?, ?)`
    ).bind(answerId, query.id, anon.rowFid, String(value), audience, nowIso, pollId),
    env.DB.prepare(
      `INSERT INTO answer_meta (id, question_id, responder_fid, privacy_tier, primary_value, pending, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?)`
    ).bind(answerId, query.id, anon.rowFid, privacyTier, String(value), nowMs),
    ...(anon.statement ? [anon.statement] : []),
  ];

  if (!existing) {
    batch.push(
      env.DB.prepare(
        `UPDATE queries SET pub_answers = pub_answers + 1 WHERE id = ?`
      ).bind(query.id),
    );
  }

  await env.DB.batch(batch);

  return snapJson(await buildScaleResults(env, query, config, value, url.origin, false));
}

async function buildScaleResults(
  env: Env,
  query: QueryRow,
  config: ScaleConfig,
  userValue: number,
  origin: string,
  alreadyAnswered: boolean,
  lockReason?: string,
): Promise<SnapResponse> {
  // Load all scale values for this question
  const scopeSql = query.poll_id ? ' AND a.poll_id = ?' : '';
  const binds = query.poll_id ? [query.id, query.poll_id] : [query.id];
  const { results } = await env.DB.prepare(
    `SELECT CAST(a.value AS REAL) as val FROM answers a
     WHERE a.q_id = ? AND a.answer_type_id = 3 AND a.audience = 'Public'${scopeSql}
     ORDER BY a.created_at DESC`
  ).bind(...binds).all() as { results: Array<{ val: number }> };

  const values = (results || []).map(r => r.val).filter(v => Number.isFinite(v));
  return scaleResultsToSnap(query, userValue, values, config, origin, alreadyAnswered, lockReason);
}

// ─── Text answer handler ──────────────────────────────────────────────────

async function handleTextSnapAnswer(
  env: Env,
  query: QueryRow,
  fid: number,
  inputs: Record<string, unknown>,
  url: URL,
  pollId: string | null,
  ctx?: { waitUntil: (p: Promise<any>) => void },
): Promise<Response> {
  const rawValue = inputs.value;
  const textValue = typeof rawValue === 'string' ? rawValue.trim() : '';

  // Validate text input
  if (!textValue || textValue.length > 280) {
    return snapJson(questionToSnap(query, url.origin));
  }

  // Neynar score gate — anonymous text answers require minimum trust score
  const ANON_SCORE_THRESHOLD = 0.6;
  const neynarUser = await getCachedNeynarUser(env, fid);
  const score = neynarUser?.score ?? 0;
  if (score < ANON_SCORE_THRESHOLD) {
    console.log(`[Snap/Text] Low score gate: score=${score} < ${ANON_SCORE_THRESHOLD}`);
    return snapJson(lowScoreSnap(query, url.origin));
  }

  // No dedup for text questions — the snap spec can't carry forward text input
  // between scenes, so the dedup confirmation flow is broken by design.
  // MC/scale/checkbox dedup still works (pre-defined choices in button actions).

  // Insert answer as Anon — the row and its meta carry the @4n0n placeholder;
  // the person is reachable only through the sealed attribution, same batch.
  const answerId = crypto.randomUUID();
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  // Ensure @4n0n bot exists in Users table (fid IS user_id after migration)
  const anonFid = Number(env.ANON_FID) || 514282;
  await ensureUserByFid(env, anonFid);
  const anon = await anonWriteFor(env, { fid, audience: 'Anon', answerId, qId: query.id, createdAt: nowIso });

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO Answers (id, q_id, user_id, value, answer_type_id, audience, created_at, poll_id)
       VALUES (?, ?, ?, ?, 1, 'Anon', ?, ?)`
    ).bind(answerId, query.id, anon.rowFid, textValue, nowIso, pollId),
    env.DB.prepare(
      `INSERT INTO answer_meta (id, question_id, responder_fid, privacy_tier, primary_value, pending, created_at)
       VALUES (?, ?, ?, 'anon', ?, 0, ?)`
    ).bind(answerId, query.id, anon.rowFid, textValue, nowMs),
    ...(anon.statement ? [anon.statement] : []),
    env.DB.prepare(
      `UPDATE queries SET pub_answers = pub_answers + 1 WHERE id = ?`
    ).bind(query.id),
  ]);

  // Cast reply via @4n0n — use waitUntil to keep worker alive during internal fetch
  const castPromise = castAnonReply(env, query, textValue, answerId);
  if (ctx?.waitUntil) {
    ctx.waitUntil(castPromise);
  } else {
    castPromise.catch(err => console.error('[Snap/Text] Anon cast failed:', err));
  }

  return snapJson(textSubmittedToSnap(query, url.origin));
}

/**
 * Cast a reply from @4n0n under the question's cast.
 */
async function castAnonReply(
  env: Env,
  query: QueryRow,
  text: string,
  answerId: string,
): Promise<void> {
  if (!query.cast_hash) {
    console.warn('[Snap/Text] No cast_hash for question, skipping anon cast', { queryId: query.id });
    return;
  }

  const anonFid = Number(env.ANON_FID) || 514282;
  console.log('[Snap/Text] Casting anon reply', { anonFid, castHash: query.cast_hash, answerId });

  try {
    const router = initCastRouter(env);
    const result = await router.publish({
      fid: anonFid,
      text,
      parentHash: query.cast_hash,
      parentAuthorFid: query.caster_fid ?? undefined,
    }, env);

    console.log('[Snap/Text] Anon cast succeeded:', { hash: result.hash, provider: result.provider });

    // Store cast hash in answer_meta for tracking
    try {
      await env.DB.prepare(
        `UPDATE answer_meta SET reply_cast_hash = ?, pending = 0 WHERE id = ?`
      ).bind(result.hash, answerId).run();
    } catch (metaErr) {
      console.error('[Snap/Text] Failed to update answer_meta with cast hash:', metaErr);
    }
  } catch (err) {
    console.error('[Snap/Text] Anon cast failed:', err);
  }
}

// ─── Checkbox answer handler ──────────────────────────────────────────────

async function handleCheckboxSnapAnswer(
  env: Env,
  query: QueryRow,
  fid: number,
  inputs: Record<string, unknown>,
  url: URL,
  options: string[],
  pollId: string | null,
): Promise<Response> {
  // Audience from the toggle_group, sticky per wave (first tallied answer decides).
  const authorTag = await anonTag(env, fid, query.id);
  const { audience } = await resolveStickyAudience(
    env.DB, query.id, fid, query.poll_id ?? null, coerceTalliedAudience(inputs.audience), authorTag,
  );
  const privacyTier = audience === 'Anon' ? 'anon' : 'public';

  // Read toggle_group selections — can be string or string[]
  const rawSelections = inputs.selections;
  let selections: string[];
  if (Array.isArray(rawSelections)) {
    selections = rawSelections.filter((s): s is string => typeof s === 'string');
  } else if (typeof rawSelections === 'string') {
    selections = [rawSelections];
  } else {
    return snapJson(questionToSnap(query, url.origin));
  }

  // Validate selections are in the options list
  selections = selections.filter(s => options.includes(s));
  if (selections.length === 0) {
    return snapJson(questionToSnap(query, url.origin));
  }

  // Ensure user exists in Users table (fid IS user_id after migration)
  await ensureUserByFid(env, fid);

  // Append-only: always INSERT. Only increment pub_answers on first checkbox answer.
  const existing = await getExistingAnswer(env.DB, query.id, fid, 4, undefined, authorTag);

  const answerId = crypto.randomUUID();
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const value = selections.join(', ');
  const indices = selections.map(s => options.indexOf(s));
  const anon = await anonWriteFor(env, { fid, audience, answerId, qId: query.id, createdAt: nowIso });

  const batch = [
    env.DB.prepare(
      `INSERT INTO Answers (id, q_id, user_id, value, answer_type_id, answer_data, audience, created_at, poll_id)
       VALUES (?, ?, ?, ?, 4, ?, ?, ?, ?)`
    ).bind(answerId, query.id, anon.rowFid, value, JSON.stringify({ indices }), audience, nowIso, pollId),
    env.DB.prepare(
      `INSERT INTO answer_meta (id, question_id, responder_fid, privacy_tier, primary_value, pending, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?)`
    ).bind(answerId, query.id, anon.rowFid, privacyTier, value, nowMs),
    ...(anon.statement ? [anon.statement] : []),
  ];

  if (!existing) {
    batch.push(
      env.DB.prepare(
        `UPDATE queries SET pub_answers = pub_answers + 1 WHERE id = ?`
      ).bind(query.id),
    );
  }

  await env.DB.batch(batch);

  return snapJson(await buildCheckboxResults(env, query, selections, url.origin));
}

async function buildCheckboxResults(
  env: Env,
  query: QueryRow,
  selected: string[],
  origin: string,
  lockReason?: string,
): Promise<SnapResponse> {
  const { optionCounts } = await getCheckboxCounts(env.DB, query.id, query.poll_id);
  return checkboxResultsToSnap(query, selected, optionCounts, origin, lockReason);
}
