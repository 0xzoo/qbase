/**
 * Webhooks Routes
 *
 * Handles:
 * - POST /webhooks/neynar    — Neynar miniapp lifecycle events
 * - POST /webhooks/hypersnap — Hypersnap Farcaster events (cast.created, cast.deleted, ...)
 *
 * Hypersnap shape (Neynar-compatible): body is raw JSON, HMAC-SHA512 over
 * the raw bytes is passed in `X-Neynar-Signature` as lowercase hex.
 * See docs/hypersnap/data-layer.md § Indexer & Reconciliation Pipeline.
 */

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
  try {
    const event = (await request.json()) as {
      type: 'miniapp.add' | 'miniapp.remove' | 'notifications.enabled' | 'notifications.disabled';
      fid: number;
      timestamp: string;
      notification_details?: { url: string; token: string };
    };

    console.log(`[Webhook/Neynar] ${event.type} FID=${event.fid}`);
    const key = `miniapp_added:${event.fid}`;
    switch (event.type) {
      case 'miniapp.add':
        await env.KV_USER_PROFILES.put(key, 'true');
        break;
      case 'miniapp.remove':
        await env.KV_USER_PROFILES.put(key, 'false');
        break;
      case 'notifications.enabled':
        await env.KV_USER_PROFILES.put(`notifications_enabled:${event.fid}`, 'true');
        break;
      case 'notifications.disabled':
        await env.KV_USER_PROFILES.put(`notifications_enabled:${event.fid}`, 'false');
        break;
    }
    return Response.json({ success: true });
  } catch (error) {
    console.error('[Webhook/Neynar] error', error);
    return new Response('Internal Server Error', { status: 500 });
  }
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
  const cast = event.data;
  const embedHost: string = env.QBASE_EMBED_HOST ?? EMBED_HOST_DEFAULT;

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
  if (!relevant) return;

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

async function verifyHmacSha512(secret: string, body: string, sigHex: string): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-512' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const macHex = bufToHex(mac);
  return timingSafeEqualHex(macHex, sigHex.toLowerCase());
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
