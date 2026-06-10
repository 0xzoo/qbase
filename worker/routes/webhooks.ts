/**
 * Webhooks Routes
 *
 * Handles:
 * - POST /webhooks/neynar    — Farcaster mini-app lifecycle events. Manifest
 *     `webhookUrl` points directly at this URL, so events arrive as JFS-signed
 *     messages (`{header, payload, signature}`) from the Farcaster client, not
 *     as Neynar-relayed HMAC envelopes. Verification = Ed25519 over the
 *     base64url-encoded `${header}.${payload}` against the user's app signer
 *     key, then a Farcaster Hub lookup to confirm the key is registered to the
 *     claimed FID. Hub response is cached in KV (1h positive / 5min negative)
 *     to keep webhook latency low and avoid hammering HUB_ENDPOINT.
 * - POST /webhooks/hypersnap — Hypersnap Farcaster events (cast.created, …).
 *     Body is raw JSON; HMAC-SHA512 over the raw bytes is passed in
 *     `X-Hypersnap-Signature` as lowercase hex. See
 *     docs/hypersnap/data-layer.md § Indexer & Reconciliation Pipeline.
 */

import { ed25519 } from '@noble/curves/ed25519';

type Env = any;

const EMBED_HOST_DEFAULT = 'qbase.tech';
const EMBED_PATH_PREFIX = '/q/';
const DEDUPE_TTL_SECONDS = 60 * 60 * 24; // 24h — webhook replays past this are harmless re-ingest

export async function handleWebhookRoutes(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const pathname = url.pathname;

  if (pathname === '/webhooks/neynar' && request.method === 'POST') {
    return handleNeynarMiniapp(request, env);
  }

  if (pathname === '/webhooks/hypersnap' && request.method === 'POST') {
    return handleHypersnap(request, env);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Neynar miniapp lifecycle (unchanged)
// ---------------------------------------------------------------------------

async function handleNeynarMiniapp(request: Request, env: Env): Promise<Response> {
  let body: { header?: string; payload?: string; signature?: string };
  try {
    body = await request.json();
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }
  if (!body.header || !body.payload || !body.signature) {
    return new Response('Missing JFS fields', { status: 400 });
  }

  // Decode header + payload from base64url. Header carries fid + signing key;
  // payload carries the actual event.
  let headerObj: { fid: number; type: string; key: string };
  let payloadObj: { event: string; notificationDetails?: { url: string; token: string } };
  try {
    headerObj = JSON.parse(b64urlToString(body.header));
    payloadObj = JSON.parse(b64urlToString(body.payload));
  } catch {
    return new Response('Invalid JFS encoding', { status: 400 });
  }

  if (headerObj.type !== 'app_key' || typeof headerObj.fid !== 'number' || typeof headerObj.key !== 'string') {
    return new Response('Unsupported JFS header', { status: 400 });
  }

  // Ed25519 verify signature over `${header}.${payload}` (the raw base64url
  // pieces, joined by a dot — matches the JFS spec).
  const message = new TextEncoder().encode(`${body.header}.${body.payload}`);
  let publicKey: Uint8Array;
  let signature: Uint8Array;
  try {
    publicKey = hexToBytes(stripHexPrefix(headerObj.key));
    signature = b64urlToBytes(body.signature);
  } catch {
    return new Response('Invalid key/signature encoding', { status: 400 });
  }

  let sigValid = false;
  try {
    sigValid = ed25519.verify(signature, message, publicKey);
  } catch (err) {
    console.warn('[Webhook/Neynar] ed25519.verify threw:', err);
  }
  if (!sigValid) {
    console.warn(`[Webhook/Neynar] Signature invalid for fid=${headerObj.fid}`);
    return new Response('Bad signature', { status: 401 });
  }

  // Confirm the signing key is currently registered to the claimed FID
  // via the Farcaster key registry (Hub).
  const authorized = await isFidSigner(env, headerObj.fid, headerObj.key);
  if (!authorized) {
    console.warn(`[Webhook/Neynar] Key ${headerObj.key.substring(0, 14)}… not registered to FID ${headerObj.fid}`);
    return new Response('Key not authorized', { status: 401 });
  }

  // Map JFS event names → KV keys used by the rest of the app.
  // Accept both the modern (miniapp_*) and any older (frame_*, miniapp.*) names
  // so a Farcaster client that has not yet rotated naming still wires up.
  const fid = headerObj.fid;
  const event = payloadObj.event;
  console.log(`[Webhook/Neynar] event=${event} fid=${fid}`);
  switch (event) {
    case 'miniapp_added':
    case 'frame_added':
    case 'miniapp.add':
      await env.KV_USER_PROFILES.put(`miniapp_added:${fid}`, 'true');
      // Some clients ship notification details with the add event itself.
      if (payloadObj.notificationDetails) {
        await env.KV_USER_PROFILES.put(`notifications_enabled:${fid}`, 'true');
      }
      break;
    case 'miniapp_removed':
    case 'frame_removed':
    case 'miniapp.remove':
      await env.KV_USER_PROFILES.put(`miniapp_added:${fid}`, 'false');
      break;
    case 'notifications_enabled':
    case 'notifications.enabled':
      await env.KV_USER_PROFILES.put(`notifications_enabled:${fid}`, 'true');
      break;
    case 'notifications_disabled':
    case 'notifications.disabled':
      await env.KV_USER_PROFILES.put(`notifications_enabled:${fid}`, 'false');
      break;
    default:
      console.log(`[Webhook/Neynar] Ignored unknown event type: ${event}`);
  }
  return Response.json({ success: true });
}

/**
 * Confirm `key` is an active app signer for `fid` per the Farcaster key
 * registry (queried via HUB_ENDPOINT). Cached in KV: 1h on HIT, 5min on MISS
 * so a freshly added signer recovers within a few minutes.
 */
async function isFidSigner(env: Env, fid: number, keyHexInput: string): Promise<boolean> {
  const keyNorm = '0x' + stripHexPrefix(keyHexInput).toLowerCase();
  const cacheKey = `signer:${fid}:${keyNorm}`;
  const cached = await env.KV_USER_PROFILES.get(cacheKey);
  if (cached === '1') return true;
  if (cached === '0') return false;

  const hub: string | undefined = env.HUB_ENDPOINT;
  if (!hub) {
    console.error('[Webhook/Neynar] HUB_ENDPOINT not configured — cannot verify signer');
    return false;
  }

  let active = false;
  try {
    const url = `${hub.replace(/\/$/, '')}/v1/onChainSignersByFid?fid=${fid}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`[Webhook/Neynar] Hub signer lookup ${res.status} for fid=${fid}`);
      // Don't cache transient failures — let the next request retry.
      return false;
    }
    const data = await res.json() as {
      events?: Array<{ signerEventBody?: { key?: string; eventType?: string } }>;
    };
    // Walk the event log to compute current state per key (last event wins).
    const state = new Map<string, boolean>();
    for (const ev of data.events ?? []) {
      const k = ev.signerEventBody?.key;
      if (!k) continue;
      const norm = '0x' + stripHexPrefix(k).toLowerCase();
      const remove = ev.signerEventBody?.eventType === 'SIGNER_EVENT_TYPE_REMOVE';
      state.set(norm, !remove);
    }
    active = state.get(keyNorm) === true;
  } catch (err) {
    console.error('[Webhook/Neynar] Hub signer lookup threw:', err);
    return false;
  }

  try {
    await env.KV_USER_PROFILES.put(cacheKey, active ? '1' : '0', {
      expirationTtl: active ? 3600 : 300,
    });
  } catch {
    // KV pressure — don't fail the verification path.
  }
  return active;
}

function stripHexPrefix(s: string): string {
  return s.startsWith('0x') || s.startsWith('0X') ? s.slice(2) : s;
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error('invalid hex');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlToString(s: string): string {
  return new TextDecoder().decode(b64urlToBytes(s));
}

// ---------------------------------------------------------------------------
// Hypersnap events
// ---------------------------------------------------------------------------

async function handleHypersnap(request: Request, env: Env): Promise<Response> {
  // Accept secrets from both webhooks (cast_created + cast_deleted may have
  // separate secrets if registered individually). Comma-separated or single.
  const secretsRaw: string | undefined = env.HYPERSNAP_WEBHOOK_SECRET;
  if (!secretsRaw) {
    console.error('[Webhook/Hypersnap] HYPERSNAP_WEBHOOK_SECRET not configured');
    return new Response('Not configured', { status: 503 });
  }
  const secrets = secretsRaw.split(',').map(s => s.trim()).filter(Boolean);

  const raw = await request.text();
  const signature = request.headers.get('x-hypersnap-signature');
  if (!signature) return new Response('Missing signature', { status: 401 });

  let verified = false;
  for (const secret of secrets) {
    if (await verifyHmacSha512(secret, raw, signature)) {
      verified = true;
      break;
    }
  }
  if (!verified) {
    console.warn('[Webhook/Hypersnap] HMAC mismatch (tried all secrets)');
    return new Response('Bad signature', { status: 401 });
  }

  let event: HypersnapEvent;
  try {
    event = JSON.parse(raw) as HypersnapEvent;
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  const dedupeKey = buildDedupeKey(event);
  if (dedupeKey) {
    const seen = await env.KV_FRAME_NOTIFICATIONS.get(dedupeKey);
    if (seen) {
      console.log(`[Webhook/Hypersnap] dedupe hit ${dedupeKey}`);
      return Response.json({ success: true, dedupe: true });
    }
    await env.KV_FRAME_NOTIFICATIONS.put(dedupeKey, '1', { expirationTtl: DEDUPE_TTL_SECONDS });
  }

  try {
    switch (event.type) {
      case 'cast.created':
        await onCastCreated(event as CastCreatedEvent, env);
        break;
      case 'cast.deleted':
        await onCastDeleted(event as CastDeletedEvent, env);
        break;
      default:
        console.log(`[Webhook/Hypersnap] ignored type=${(event as any).type}`);
    }
    return Response.json({ success: true });
  } catch (error) {
    console.error('[Webhook/Hypersnap] handler error', error);
    return new Response('Internal Server Error', { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

async function onCastCreated(event: CastCreatedEvent, env: Env): Promise<void> {
  // Hypersnap may deliver the cast nested under data.cast or flat as data.
  const cast = (((event.data as any)?.cast) ?? event.data) as CastPayload;
  const embedHost: string = env.QBASE_EMBED_HOST ?? EMBED_HOST_DEFAULT;

  console.log(`[Webhook/Hypersnap] cast.created parent=${cast?.parent_hash ?? 'none'} text="${(cast?.text ?? '').slice(0, 80)}"`);

  // Persistent diagnostic (survives tail disconnects) — read with:
  //   wrangler kv key get hs_council_debug --binding KV_FRAME_NOTIFICATIONS --remote
  try {
    await env.KV_FRAME_NOTIFICATIONS.put('hs_council_debug', JSON.stringify({
      ts: Date.now(),
      shape: (event.data as any)?.cast ? 'nested(data.cast)' : 'flat(data)',
      parent: cast?.parent_hash ?? null,
      author: cast?.author?.fid ?? null,
      text: (cast?.text ?? '').slice(0, 200),
      isCouncil: isCouncilSummon(cast),
    }), { expirationTtl: 3600 });
  } catch { /* diagnostic only */ }

  // Oracle council: "@qgent council" as a reply to a question cast summons all models.
  // Checked before relevance so it works even when the parent is a tracked qbase question.
  if (isCouncilSummon(cast)) {
    console.log('[Webhook/Hypersnap] Council summon on parent', cast.parent_hash);
    await dispatchCouncil(cast, env);
    return;
  }

  const parentHash = cast.parent_hash ?? null;
  const questionIdFromEmbed = extractQuestionId(cast, embedHost);

  // A cast is relevant if either:
  //   - it carries a qbase.tech/q/<id> embed (itself a question candidate or bot pointer)
  //   - it is a reply to a cast we already track in question_meta (answer-side)
  let relevant = !!questionIdFromEmbed;
  if (!relevant && parentHash) {
    const parent = await env.DB.prepare(
      'SELECT question_id FROM question_meta WHERE cast_hash = ? LIMIT 1',
    ).bind(parentHash).first();
    relevant = !!parent;
  }
  if (!relevant) {
    return;
  }

  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO pending_cast_index
       (cast_hash, question_id, author_fid, cast_text, parent_hash, first_seen_at, reconciled)
     VALUES (?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT(cast_hash) DO NOTHING`,
  ).bind(
    cast.hash,
    questionIdFromEmbed,
    cast.author?.fid ?? 0,
    cast.text ?? '',
    parentHash,
    now,
  ).run();
}

async function onCastDeleted(event: CastDeletedEvent, env: Env): Promise<void> {
  const castHash = event.data.hash;
  const now = Date.now();

  const question = await env.DB.prepare(
    'SELECT question_id, author_fid FROM question_meta WHERE cast_hash = ? LIMIT 1',
  ).bind(castHash).first() as { question_id: string; author_fid: number } | null;

  if (!question) {
    // Not a tracked question; nothing to do. Answer-side deletions are
    // reconciled via answer_meta in Phase 2.
    return;
  }

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO question_cast_history (question_id, cast_hash, author_fid, status, transitioned_at)
       VALUES (?, ?, ?, 'deleted', ?)
       ON CONFLICT(question_id, cast_hash) DO NOTHING`,
    ).bind(question.question_id, castHash, question.author_fid, now),
    env.DB.prepare(
      `UPDATE question_meta SET cast_status = 'deleted', updated_at = ?
       WHERE question_id = ? AND cast_hash = ?`,
    ).bind(now, question.question_id, castHash),
  ]);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildDedupeKey(event: HypersnapEvent): string | null {
  if (event.type === 'cast.created' || event.type === 'cast.deleted') {
    return `hs_dedup:${event.type}:${(event as CastCreatedEvent | CastDeletedEvent).data.hash}`;
  }
  return null;
}

function extractQuestionId(cast: CastPayload, embedHost: string): string | null {
  const embeds = cast.embeds ?? [];
  for (const e of embeds) {
    if (!e.url) continue;
    const id = parseQuestionIdFromUrl(e.url, embedHost);
    if (id) return id;
  }
  // Cast text fallback — pasted URL without embed parse
  if (cast.text) {
    const match = cast.text.match(new RegExp(`https?://${escapeRegex(embedHost)}/q/([A-Za-z0-9_-]+)`));
    if (match) return match[1];
  }
  return null;
}

function parseQuestionIdFromUrl(urlStr: string, embedHost: string): string | null {
  try {
    const u = new URL(urlStr);
    if (u.hostname !== embedHost) return null;
    if (!u.pathname.startsWith(EMBED_PATH_PREFIX)) return null;
    const id = u.pathname.slice(EMBED_PATH_PREFIX.length).split('/')[0];
    return id || null;
  } catch {
    return null;
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function hmacSha512Hex(keyBytes: Uint8Array, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'HMAC', hash: 'SHA-512' }, false, ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return bufToHex(mac);
}

function tryHexDecode(s: string): Uint8Array | null {
  const t = s.startsWith('0x') ? s.slice(2) : s;
  if (t.length < 2 || t.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(t)) return null;
  const out = new Uint8Array(t.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(t.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function tryBase64Decode(s: string): Uint8Array | null {
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.length ? out : null;
  } catch { return null; }
}

// Hypersnap webhook secrets may be a raw string, hex, or base64 — try each as the
// HMAC key. Logs which encoding matched so we can lock it in once known.
async function verifyHmacSha512(secret: string, body: string, sigHex: string): Promise<boolean> {
  const sig = sigHex.toLowerCase();
  const candidates: Array<[string, Uint8Array]> = [['utf8', new TextEncoder().encode(secret)]];
  const hexBytes = tryHexDecode(secret);
  if (hexBytes) candidates.push(['hex', hexBytes]);
  const b64Bytes = tryBase64Decode(secret);
  if (b64Bytes) candidates.push(['base64', b64Bytes]);

  for (const [enc, keyBytes] of candidates) {
    if (timingSafeEqualHex(await hmacSha512Hex(keyBytes, body), sig)) {
      console.log(`[Webhook/Hypersnap] HMAC ok (secret encoding=${enc})`);
      return true;
    }
  }
  console.warn(
    `[Webhook/Hypersnap] HMAC no-match. recv=${sig.slice(0, 12)} ` +
    `utf8=${(await hmacSha512Hex(candidates[0][1], body)).slice(0, 12)} ` +
    `bodyLen=${body.length}`,
  );
  return false;
}

function bufToHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const ORACLE_COUNCIL = ['qlaude', 'qemini', 'chatqpt'];

/**
 * Detect an oracle-council summon: a reply ("@qgent council …") to a question cast.
 * This webhook is subscribed to @qgent mentions only (mentioned_fids:[975961]), and
 * Farcaster strips the @mention out of cast.text — so we match the "council" keyword
 * on a reply, not the literal "@qgent" (which never appears in the text).
 */
function isCouncilSummon(cast: CastPayload): boolean {
  if (!cast.parent_hash) return false;
  return /\bcouncil\b/i.test(cast.text ?? '');
}

/**
 * Summon the oracle council. The question is the PARENT cast's text; each model
 * answers as itself (its own signer) replying to that original question cast.
 */
async function dispatchCouncil(cast: CastPayload, env: any): Promise<void> {
  const questionCastHash = cast.parent_hash;
  if (!questionCastHash) return;

  // The question is the parent (question) cast's text.
  const { createHypersnapService } = await import('../services/HypersnapService');
  let questionText: string | undefined;
  try {
    const parent = await createHypersnapService(env).getCastByHash(questionCastHash);
    questionText = parent?.text?.trim();
  } catch (error) {
    console.error('[Webhook/Hypersnap] Council: failed to fetch parent cast', error);
    return;
  }
  if (!questionText) {
    console.log('[Webhook/Hypersnap] Council: no question text in parent', questionCastHash);
    return;
  }

  const oracleStub = env.ORACLE.get(env.ORACLE.idFromName('oracle'));
  const payload = {
    question: questionText,
    models: ORACLE_COUNCIL,
    askerFid: cast.author?.fid ?? 0,        // the summoner
    askerUsername: cast.author?.username ?? '',
    parentHash: questionCastHash,            // models reply to the original question cast
    castText: questionText,
  };

  console.log('[Webhook/Hypersnap] Council dispatch:', JSON.stringify({
    question: questionText.substring(0, 60),
    parentHash: questionCastHash,
    summonHash: cast.hash,
  }));

  try {
    const response = await oracleStub.fetch('http://oracle/dispatch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      console.error('[Webhook/Hypersnap] Council dispatch failed:', response.status, await response.text());
      return;
    }
    console.log('[Webhook/Hypersnap] Council dispatch result:', JSON.stringify(await response.json()));
  } catch (error) {
    console.error('[Webhook/Hypersnap] Council dispatch threw:', error);
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CastAuthor {
  fid: number;
  username?: string;
}

interface CastEmbed {
  url?: string;
  cast_id?: { fid: number; hash: string };
}

interface CastPayload {
  hash: string;
  author: CastAuthor;
  text?: string;
  parent_hash?: string | null;
  embeds?: CastEmbed[];
  timestamp?: string;
}

interface CastCreatedEvent {
  type: 'cast.created';
  data: CastPayload;
}

interface CastDeletedEvent {
  type: 'cast.deleted';
  data: { hash: string };
}

type HypersnapEvent =
  | CastCreatedEvent
  | CastDeletedEvent
  | { type: string; data: unknown };
