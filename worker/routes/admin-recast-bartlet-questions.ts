/**
 * admin-recast-bartlet-questions — re-cast the 15 bartlet questions when the
 * original casts' snap embeds got stuck behind a Farcaster client cache (e.g.
 * a 404 cached before /snap/question/* allowed underscored ids).
 *
 * POST /api/admin/recast-bartlet-questions
 *
 * Per question:
 *   1. DELETE farcaster_casts row (clears stale cast hash from joins)
 *   2. Cast fresh via @4n0n with ?v=<batchTimestamp> cache-buster on the
 *      embed URL — different URL ⇒ different cache key
 *   3. INSERT farcaster_casts with the new cast hash
 *   4. UPDATE question_meta with the new cast_hash
 *
 * Auth: X-Admin-Secret header must match env.QBASE_ADMIN_SECRET.
 *
 * Pre-requisite: run /api/admin/register-bartlet-queries first (this route
 * assumes queries + question_meta rows already exist).
 *
 * Side-effect on Farcaster: the old casts will remain on @4n0n's feed until
 * deleted manually via the FC client — this route only governs our DB and
 * what we cast next. Delete the old casts to clean up the feed.
 */

import { bartletQuestions } from '../services/bartlet/questions';
import { generateCompactToken } from '../services/SnapService';
import { anon_fid } from '../../src/lib/consts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

interface RecastResult {
  questionId: string;
  status: 'recast' | 'no_meta' | 'error';
  oldCastHash?: string;
  newCastHash?: string;
  error?: string;
}

export async function handleAdminRecastBartletQuestions(
  request: Request,
  env: Env
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/api/admin/recast-bartlet-questions' || request.method !== 'POST') {
    return null;
  }

  const secret = request.headers.get('X-Admin-Secret');
  if (secret !== env.QBASE_ADMIN_SECRET) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }

  const anonSignerKey: string | undefined = env.ANON_SIGNER_KEY;
  if (!anonSignerKey) {
    return Response.json({ error: 'ANON_SIGNER_KEY not configured' }, { status: 500 });
  }

  const { createHypersnapService } = await import('../services/HypersnapService');
  const hypersnap = createHypersnapService(env);
  const { FarcasterDBService } = await import('../services/FarcasterDBService');

  const hostname = env.HOSTNAME || 'qbase.tech';
  const baseUrl = hostname.startsWith('http') ? hostname : `https://${hostname}`;

  // Single batch timestamp — every cast in this run shares the same cache
  // key namespace (so re-running this route again yields a fresh batch).
  const batchVersion = Date.now();

  const results: RecastResult[] = [];

  for (const q of bartletQuestions) {
    try {
      // Pre-flight: this route only recasts questions that already have a
      // question_meta row from the original registration. If missing, skip.
      const meta = await env.DB.prepare(
        'SELECT question_id, cast_hash FROM question_meta WHERE question_id = ?'
      ).bind(q.id).first();

      if (!meta) {
        results.push({ questionId: q.id, status: 'no_meta' });
        continue;
      }

      const oldCastHash = (meta.cast_hash as string | null) ?? undefined;

      // ── Step 1: clear the stale farcaster_casts row ──
      await env.DB.prepare(
        "DELETE FROM farcaster_casts WHERE entity_type = 'query' AND entity_id = ?"
      ).bind(q.id).run();

      // ── Step 2: cast fresh with cache-busted embed URL ──
      const compactToken = await generateCompactToken(q.id, env.QBASE_SECRET);
      const embedUrl = `${baseUrl}/snap/question/${q.id}?compact=1&token=${compactToken}&v=${batchVersion}`;

      const cast = await hypersnap.publishCast({
        signerKey: anonSignerKey,
        fid: anon_fid,
        text: q.stem,
        embeds: [{ url: embedUrl }],
      });

      // ── Step 3: insert fresh farcaster_casts row ──
      await FarcasterDBService.upsertCast(env.DB, {
        entity_type: 'query',
        entity_id: q.id,
        cast_hash: cast.hash,
        cast_url: `https://farcaster.xyz/4n0n/${cast.hash}`,
        caster_fid: anon_fid,
      });

      // ── Step 4: point question_meta at the new cast ──
      await env.DB.prepare(
        "UPDATE question_meta SET cast_hash = ?, cast_status = 'active', updated_at = ? WHERE question_id = ?"
      ).bind(cast.hash, Date.now(), q.id).run();

      results.push({
        questionId: q.id,
        status: 'recast',
        oldCastHash,
        newCastHash: cast.hash,
      });

      // Rate limit: 1s between casts to stay polite to the Hypersnap hub.
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({ questionId: q.id, status: 'error', error: msg });
    }
  }

  const recast = results.filter((r) => r.status === 'recast').length;
  const noMeta = results.filter((r) => r.status === 'no_meta').length;
  const errors = results.filter((r) => r.status === 'error').length;

  return Response.json({
    ok: true,
    summary: { recast, noMeta, errors, batchVersion },
    results,
  });
}
