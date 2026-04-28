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
  questionToSnapCompact,
  questionResultsToSnap,
  scaleResultsToSnap,
  textSubmittedToSnap,
  checkboxResultsToSnap,
  resolveScaleConfig,
  bartletIntroSnap,
  bartletQuestionSnap,
  bartletResultSnap,
  parseOptions,
  verifyCompactToken,
  SNAP_CONTENT_TYPE,
  type QueryRow,
  type ScaleConfig,
  type SnapResponse,
} from '../services/SnapService';
import {
  BARTLET_LENGTH,
  applyAnswer,
  readState,
} from '../services/BartletQuiz';
import { BARTLET_PATH, BARTLET_DEV_PATH, handleBartletSnap } from './bartlet';
import { initCastRouter } from '../services/casting';
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
      'Vary': 'Accept',
      ...CORS_HEADERS,
      ...(init.headers || {}),
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
 * Resolve a Farcaster FID to the internal Users.id.
 * Creates the user row if it doesn't exist (same as ensureUserExists).
 */
async function resolveUserId(env: Env, fid: number): Promise<number | null> {
  const existing = await env.DB.prepare('SELECT id FROM Users WHERE fid = ?').bind(fid).first();
  if (existing) return (existing as { id: number }).id;

  // Auto-create user (minimal — fname will be fetched lazily by UserService)
  try {
    const result = await env.DB.prepare(
      'INSERT INTO Users (fid, fname) VALUES (?, ?) RETURNING id'
    ).bind(fid, `user-${fid}`).first();
    return result ? (result as { id: number }).id : null;
  } catch {
    // Race condition: another request created it — re-read
    const retry = await env.DB.prepare('SELECT id FROM Users WHERE fid = ?').bind(fid).first();
    return retry ? (retry as { id: number }).id : null;
  }
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

export async function handleSnapRoutes(request: Request, env: Env, ctx?: { waitUntil: (p: Promise<any>) => void }): Promise<Response | null> {
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

  const snapSessionId = queryId;
  const options = parseOptions(query.a_options);

  // ── GET — always shows vote buttons (no cookie, no FID available) ──

  if (parsed.action.type === 'get') {
    // Always show scene 1 — @farcaster/snap doesn't provide user identity on GET.
    // UPSERT in the DB prevents double-counting if the same user votes again.
    // Same-option re-votes are idempotent; changed-vote updates silently.
    const { total: snapTotal } = await loadSnapCounts(env, queryId, snapSessionId, options);
    const queryWithSnapCount = { ...query, pub_answers: snapTotal || query.pub_answers };

    // Compact mode: answer input only, no question stem. HMAC-gated to qbase-created casts.
    const compact = url.searchParams.get('compact') === '1';
    const token = url.searchParams.get('token') || '';
    if (compact && env.QBASE_SECRET) {
      const valid = await verifyCompactToken(queryId, token, env.QBASE_SECRET);
      if (valid) {
        return snapJson(questionToSnapCompact(queryWithSnapCount, url.origin), {
          headers: { 'Cache-Control': 'no-store' },
        });
      }
      // Invalid/missing token → serve full snap (silent fallback)
    }

    return snapJson(questionToSnap(queryWithSnapCount, url.origin), {
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  // ── POST — verified interaction ──

  const fid = parsed.action.user.fid;
  const inputs = parsed.action.inputs;
  console.log(`[Snap/POST] queryId=${queryId} type=${query.type} fid=${fid} inputs=`, JSON.stringify(inputs));

  try {

  // ── MC poll — existing flow (upsert to answer_snap) ──
  if (query.type === 'mc') {
    const urlChoice = url.searchParams.get('choice');
    const choice = urlChoice ||
      (typeof inputs.choice === 'string' ? inputs.choice : null);

    if (options.length === 0 || !choice || !options.includes(choice)) {
      return snapJson(questionToSnap(query, url.origin));
    }

    const choiceIndex = options.indexOf(choice);

    await env.DB.prepare(
      `INSERT INTO answer_snap (question_id, fid, option_index, snap_session_id)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(question_id, fid, snap_session_id) DO UPDATE SET
         option_index = excluded.option_index`
    ).bind(queryId, fid, choiceIndex, snapSessionId).run();

    const { counts } = await loadSnapCounts(env, queryId, snapSessionId, options);
    return snapJson(questionResultsToSnap(query, counts, choice, url.origin, false));
  }

  // ── Scale — slider value → answers table ──
  if (query.type === 'scale') {
    return handleScaleSnapAnswer(env, query, fid, inputs, url);
  }

  // ── Text — text input → answers table → @4n0n cast ──
  if (query.type === 'text') {
    return handleTextSnapAnswer(env, query, fid, inputs, url, ctx);
  }

  // ── Checkbox — toggle selections → answers table ──
  if (query.type === 'checkbox') {
    if (options.length > 6) {
      return snapJson(questionToSnap(query, url.origin));
    }
    return handleCheckboxSnapAnswer(env, query, fid, inputs, url, options);
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
          back_btn: { type: 'button', props: { label: 'Try again', variant: 'secondary' }, on: { press: { action: 'submit', params: { target: url.origin + `/snap/question/${queryId}` } } } },
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
): Promise<Response> {
  const config = resolveScaleConfig(query);
  if (!config) return snapJson(questionToSnap(query, url.origin));

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

  // Insert new answer
  const answerId = crypto.randomUUID();
  const now = Date.now();

  // Resolve Farcaster FID to internal user ID (FK constraint on Answers.user_id → Users.id)
  const userId = await resolveUserId(env, fid);
  if (!userId) return snapJson(questionToSnap(query, url.origin));

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO answers (id, q_id, user_id, value, answer_type_id, audience, created_at)
       VALUES (?, ?, ?, ?, 3, 'Public', ?)`
    ).bind(answerId, query.id, userId, String(value), now),
    env.DB.prepare(
      `INSERT INTO answer_meta (id, question_id, responder_fid, privacy_tier, primary_value, pending, created_at)
       VALUES (?, ?, ?, 'public', ?, 0, ?)`
    ).bind(answerId, query.id, fid, String(value), now),
    env.DB.prepare(
      `UPDATE queries SET pub_answers = pub_answers + 1 WHERE id = ?`
    ).bind(query.id),
  ]);

  return snapJson(await buildScaleResults(env, query, config, value, url.origin, false));
}

async function buildScaleResults(
  env: Env,
  query: QueryRow,
  config: ScaleConfig,
  userValue: number,
  origin: string,
  alreadyAnswered: boolean,
): Promise<SnapResponse> {
  // Load all scale values for this question
  const { results } = await env.DB.prepare(
    `SELECT CAST(a.value AS REAL) as val FROM answers a
     WHERE a.q_id = ? AND a.answer_type_id = 3 AND a.audience = 'Public'
     ORDER BY a.created_at DESC`
  ).bind(query.id).all() as { results: Array<{ val: number }> };

  const values = (results || []).map(r => r.val).filter(v => Number.isFinite(v));
  return scaleResultsToSnap(query, userValue, values, config, origin, alreadyAnswered);
}

// ─── Text answer handler ──────────────────────────────────────────────────

async function handleTextSnapAnswer(
  env: Env,
  query: QueryRow,
  fid: number,
  inputs: Record<string, unknown>,
  url: URL,
  ctx?: { waitUntil: (p: Promise<any>) => void },
): Promise<Response> {
  const rawValue = inputs.value;
  const textValue = typeof rawValue === 'string' ? rawValue.trim() : '';

  // Validate text input
  if (!textValue || textValue.length > 280) {
    return snapJson(questionToSnap(query, url.origin));
  }

  // No dedup for text questions — the snap spec can't carry forward text input
  // between scenes, so the dedup confirmation flow is broken by design.
  // MC/scale/checkbox dedup still works (pre-defined choices in button actions).

  // Insert answer as Anon — user_id is the @4n0n bot, real FID only in answer_meta for dedup
  const answerId = crypto.randomUUID();
  const now = Date.now();

  // Resolve @4n0n bot's internal user ID (FK constraint on Answers.user_id → Users.id)
  const anonFid = Number(env.ANON_FID) || 514282;
  const anonUserId = await resolveUserId(env, anonFid);
  if (!anonUserId) return snapJson(textSubmittedToSnap(query, url.origin));

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO answers (id, q_id, user_id, value, answer_type_id, audience, created_at)
       VALUES (?, ?, ?, ?, 1, 'Anon', ?)`
    ).bind(answerId, query.id, anonUserId, textValue, now),
    env.DB.prepare(
      `INSERT INTO answer_meta (id, question_id, responder_fid, privacy_tier, primary_value, pending, created_at)
       VALUES (?, ?, ?, 'anon', ?, 0, ?)`
    ).bind(answerId, query.id, fid, textValue, now),
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
): Promise<Response> {
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

  // Insert answer — value is comma-joined selections, answer_data has indices
  const answerId = crypto.randomUUID();
  const now = Date.now();
  const value = selections.join(', ');
  const indices = selections.map(s => options.indexOf(s));

  // Resolve Farcaster FID to internal user ID (FK constraint on Answers.user_id → Users.id)
  const userId = await resolveUserId(env, fid);
  if (!userId) return snapJson(await buildCheckboxResults(env, query, selections, url.origin));

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO answers (id, q_id, user_id, value, answer_type_id, answer_data, audience, created_at)
       VALUES (?, ?, ?, ?, 4, ?, 'Public', ?)`
    ).bind(answerId, query.id, userId, value, JSON.stringify({ indices }), now),
    env.DB.prepare(
      `INSERT INTO answer_meta (id, question_id, responder_fid, privacy_tier, primary_value, pending, created_at)
       VALUES (?, ?, ?, 'public', ?, 0, ?)`
    ).bind(answerId, query.id, fid, value, now),
    env.DB.prepare(
      `UPDATE queries SET pub_answers = pub_answers + 1 WHERE id = ?`
    ).bind(query.id),
  ]);

  return snapJson(await buildCheckboxResults(env, query, selections, url.origin));
}

async function buildCheckboxResults(
  env: Env,
  query: QueryRow,
  selected: string[],
  origin: string,
): Promise<SnapResponse> {
  // Load aggregate per-option counts from all checkbox answers
  const { results } = await env.DB.prepare(
    `SELECT a.value FROM answers a
     WHERE a.q_id = ? AND a.answer_type_id = 4 AND a.audience = 'Public'`
  ).bind(query.id).all() as { results: Array<{ value: string }> };

  const optionCounts: Record<string, number> = {};
  for (const row of results || []) {
    const parts = row.value.split(',').map(s => s.trim());
    for (const p of parts) {
      if (p) optionCounts[p] = (optionCounts[p] ?? 0) + 1;
    }
  }

  return checkboxResultsToSnap(query, selected, optionCounts, origin);
}
