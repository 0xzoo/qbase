/**
 * admin-register-bartlet-queries — full canonical setup for the 15 bartlet
 * questions, attributed to @4n0n.
 *
 * POST /api/admin/register-bartlet-queries
 *
 * Per question, four idempotent steps (each keyed on its own primary key so a
 * partial run can resume cleanly):
 *
 *   1. queries row              — insert if missing (id = bartlet slug)
 *   2. Vectorize 'q' index      — add if missing (lookup by id first)
 *   3. Farcaster cast via @4n0n — cast if no question_meta row, then …
 *   4. question_meta + farcaster_casts — insert with the new cast hash
 *
 * Auth: X-Admin-Secret header must match env.QBASE_ADMIN_SECRET.
 *
 * Slug-as-canonical-id: bartlet questions use their hand-rolled slugs
 * (e.g. q_bartlet_innit_for) directly as queries.id. queries.id is TEXT — no
 * UUID constraint at the schema level — so slugs are valid canonical ids.
 *
 * Supersedes admin-cast-bartlet.ts: that route only did steps 3+4 with a
 * different cast text format. This one matches handlers/queries.ts so the
 * casts render as inline snap-questions like any other canonical query.
 *
 * Taxonomy: every item is classified at insert (t_26b2e821; NULL + log when
 * the classifier is unavailable). Out of scope: topic association, Q trigger.
 */

import { bartletQuestions } from '../services/bartlet/questions';
import { VectorService } from '../services/VectorService';
import { generateCompactToken } from '../services/SnapService';
import { anon_id, anon_fid } from '../../src/lib/consts';
import { classifyForRegistration, type RegistrationTaxonomyStatus } from '../services/taxonomy/registerClassify';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

interface StepResult {
  questionId: string;
  query: 'inserted' | 'skipped' | 'error';
  vector: 'inserted' | 'skipped' | 'error';
  cast: 'inserted' | 'skipped' | 'error';
  castHash?: string;
  taxonomy?: RegistrationTaxonomyStatus;
  error?: string;
}

export async function handleAdminRegisterBartletQueries(
  request: Request,
  env: Env
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/api/admin/register-bartlet-queries' || request.method !== 'POST') {
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

  const vectorService = VectorService.fromEnv(env);
  const { createHypersnapService } = await import('../services/HypersnapService');
  const hypersnap = createHypersnapService(env);
  const { FarcasterDBService } = await import('../services/FarcasterDBService');

  const hostname = env.HOSTNAME || 'qbase.tech';
  const baseUrl = hostname.startsWith('http') ? hostname : `https://${hostname}`;

  const results: StepResult[] = [];

  for (const q of bartletQuestions) {
    const r: StepResult = {
      questionId: q.id,
      query: 'skipped',
      vector: 'skipped',
      cast: 'skipped',
    };

    try {
      const optionLabels = q.a_options.map((o) => o.label);
      const aOptions = JSON.stringify(optionLabels);
      const now = new Date().toISOString();
      const nowMs = Date.now();

      // ── Step 1: queries row ──
      const existingQuery = await env.DB.prepare(
        'SELECT id FROM queries WHERE id = ?'
      ).bind(q.id).first();

      if (!existingQuery) {
        // v2 taxonomy at insert (t_26b2e821); NULL + log when the classifier is unavailable.
        const taxonomy = await classifyForRegistration(env, q.stem, optionLabels.length ? optionLabels : undefined);
        r.taxonomy = taxonomy.status;
        await env.DB.prepare(
          `INSERT INTO queries (
            id, stem, type, a_options, scale_config, date_config, cost, created_at,
            coiner_id, owner_id, coiner_fname, coiner_fid,
            token_id, casthash, tags, parent, reqs, assets, template, taxonomy,
            channel_id,
            pub_answers, priv_answers, comments
          ) VALUES (
            ?, ?, 'mc', ?, NULL, NULL, 0, ?,
            ?, ?, '4n0n', ?,
            NULL, NULL, NULL, NULL, NULL, NULL, 0, ?,
            NULL,
            0, 0, 0
          )`
        ).bind(
          q.id,
          q.stem,
          aOptions,
          now,
          anon_id,
          anon_id,
          anon_fid,
          taxonomy.json,
        ).run();
        r.query = 'inserted';
      }

      // ── Step 2: Vectorize 'q' index ──
      const existingVectors = await vectorService.getVectorsByIds([q.id], 'q');
      if (existingVectors.length === 0) {
        // Bartlet stems are short and lean on options for meaning ("innit for"
        // + ["the tech", "the bag"]). Embed in template mode so dedup catches
        // semantically-equivalent reposts.
        const embeddingText = vectorService.generateEmbeddingText(q.stem, optionLabels, true);
        const vector = await vectorService.vectorize(embeddingText);
        await vectorService.addVectors(
          [
            {
              id: q.id,
              values: vector,
              metadata: {
                stem: q.stem,
                text: q.stem,
                type: 'mc',
                created_at: now,
                coiner_id: anon_id,
                coiner_fid: anon_fid,
                coiner_fname: '4n0n',
                options_count: optionLabels.length,
              },
            },
          ],
          'q'
        );
        r.vector = 'inserted';
      }

      // ── Steps 3 + 4: cast via @4n0n + question_meta + farcaster_casts ──
      const existingMeta = await env.DB.prepare(
        'SELECT question_id FROM question_meta WHERE question_id = ?'
      ).bind(q.id).first();

      if (!existingMeta) {
        // Match handlers/queries.ts canonical cast pattern: stem only, with a
        // snap-question embed so the cast renders as an answerable snap on
        // Farcaster. People can answer the question inline (contributing to
        // the canonical query) or take the full bartlet via /snap/bartlet.
        const compactToken = await generateCompactToken(q.id, env.QBASE_SECRET);
        const embedUrl = `${baseUrl}/snap/question/${q.id}?compact=1&token=${compactToken}`;

        const cast = await hypersnap.publishCast({
          signerKey: anonSignerKey,
          fid: anon_fid,
          text: q.stem,
          embeds: [{ url: embedUrl }],
        });

        // farcaster_casts: powers stats joins in /api/queries reads.
        await FarcasterDBService.upsertCast(env.DB, {
          entity_type: 'query',
          entity_id: q.id,
          cast_hash: cast.hash,
          cast_url: `https://farcaster.xyz/4n0n/${cast.hash}`,
          caster_fid: anon_fid,
        });

        // question_meta: powers the bartlet user-publish flow (it joins on
        // question_meta.cast_hash to know which parent to reply under).
        await env.DB.prepare(
          `INSERT INTO question_meta
             (question_id, cast_hash, cast_status, author_fid, is_anon,
              answer_type_id, value_schema, topic_id, canonical_id, forked_from,
              created_at, updated_at)
           VALUES (?, ?, 'active', ?, 1, 'mc', NULL, NULL, NULL, NULL, ?, ?)`
        ).bind(q.id, cast.hash, anon_fid, nowMs, nowMs).run();

        r.cast = 'inserted';
        r.castHash = cast.hash;

        // Rate limit: 1s between casts to stay polite to the Hypersnap hub.
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      results.push(r);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({
        ...r,
        // Mark whichever step we were on as 'error'. Subsequent steps were
        // never reached, so they keep their current status.
        query: r.query === 'inserted' ? r.query : 'error',
        error: msg,
      });
    }
  }

  const tally = (key: 'query' | 'vector' | 'cast') => ({
    inserted: results.filter((r) => r[key] === 'inserted').length,
    skipped: results.filter((r) => r[key] === 'skipped').length,
    errors: results.filter((r) => r[key] === 'error').length,
  });

  return Response.json({
    ok: true,
    summary: {
      query: tally('query'),
      vector: tally('vector'),
      cast: tally('cast'),
    },
    results,
  });
}
