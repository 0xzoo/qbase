/**
 * admin-cast-bartlet — one-time script to cast all 15 bartlet questions via 4n0n.
 *
 * POST /api/admin/cast-bartlet-questions
 *
 * For each bartlet question:
 *   1. Check if question_meta already exists (idempotent skip)
 *   2. Cast via 4n0n with embed URL qbase.tech/q/<question_id>
 *   3. Insert question_meta row
 *
 * Auth: X-Admin-Secret header must match env.QBASE_ADMIN_SECRET.
 * Rate limit: 1s between casts to stay under Farcaster protocol limits.
 */

import { bartletQuestions } from '../services/bartlet/questions';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

export async function handleAdminCastBartlet(
  request: Request,
  env: Env
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/api/admin/cast-bartlet-questions' || request.method !== 'POST') {
    return null;
  }

  const secret = request.headers.get('X-Admin-Secret');
  if (secret !== env.QBASE_ADMIN_SECRET) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }

  const anonKey: string | undefined = env.ANON_SIGNER_KEY;
  if (!anonKey) {
    return Response.json({ error: 'ANON_SIGNER_KEY not configured' }, { status: 500 });
  }

  const { createHypersnapService } = await import('../services/HypersnapService');
  const hypersnap = createHypersnapService(env);

  const results: Array<{
    questionId: string;
    status: string;
    castHash?: string;
    error?: string;
  }> = [];

  for (const q of bartletQuestions) {
    // Idempotency: skip if question_meta already exists
    const existing = await env.DB.prepare(
      'SELECT question_id FROM question_meta WHERE question_id = ?'
    )
      .bind(q.id)
      .first();

    if (existing) {
      results.push({ questionId: q.id, status: 'skipped', error: 'already exists' });
      continue;
    }

    // Build cast text: stem + options + link
    const optionLabels = q.a_options.map((o) => o.label).join(' / ');
    const castText = `${q.stem}\n\n${optionLabels}\n\ntake the bartlet → qbase.tech/snap/bartlet`;

    try {
      const cast = await hypersnap.publishCast({
        signerKey: anonKey,
        fid: 514282, // 4n0n
        text: castText,
        embeds: [{ url: `https://qbase.tech/q/${q.id}` }],
      });

      // Insert question_meta
      const now = Date.now();
      await env.DB.prepare(
        `INSERT INTO question_meta
           (question_id, cast_hash, cast_status, author_fid, is_anon,
            answer_type_id, value_schema, created_at, updated_at)
         VALUES (?, ?, 'active', 514282, 1, 'choice', ?, ?, ?)`
      )
        .bind(
          q.id,
          cast.hash,
          JSON.stringify({ options: q.a_options.map((o) => o.label) }),
          now,
          now
        )
        .run();

      results.push({ questionId: q.id, status: 'cast', castHash: cast.hash });

      // Rate limit: 1s between casts
      await new Promise((r) => setTimeout(r, 1000));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({ questionId: q.id, status: 'error', error: msg });
    }
  }

  const castCount = results.filter((r) => r.status === 'cast').length;
  const skipCount = results.filter((r) => r.status === 'skipped').length;
  const errorCount = results.filter((r) => r.status === 'error').length;

  return Response.json({
    ok: true,
    summary: { cast: castCount, skipped: skipCount, errors: errorCount },
    results,
  });
}
