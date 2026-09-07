/**
 * admin-register-values-queries — full canonical setup for the 21 values
 * questions, attributed to @4n0n. Mirrors admin-register-bartlet-queries.ts
 * with question-type fan-out (Likert / forced-choice / open-text).
 *
 * POST /api/admin/register-values-queries
 *
 * Per question, four idempotent steps (each keyed on its own primary key so
 * a partial run can resume cleanly):
 *
 *   1. queries row              — insert if missing (id = values slug)
 *   2. Vectorize 'q' index      — add if missing (lookup by id first)
 *   3. Farcaster cast via @4n0n — cast if no question_meta row, then …
 *   4. question_meta + farcaster_casts — insert with the new cast hash
 *
 * Type → answer_type_id mapping (driven by handlers/queries.ts:289
 * SIGNER_REQUIRED_TYPES):
 *   likert  → 'scale'   (5-point; signer-required for answers)
 *   forced  → 'mc'      (2-option; anon-able)
 *   open    → 'text'    (free-text; signer-required for answers)
 *
 * Likert questions store the 5-point scale shape in `scale_config` (min=1,
 * max=5, customLabels). The platform's scaleQuestionToSnap (SnapService.ts)
 * renders these as a slider with endpoint labels, exactly like the example
 * casts at farcaster.xyz/zoo/0xee12f818.
 *
 * Auth: X-Admin-Secret header must match env.QBASE_ADMIN_SECRET.
 */
import { LIKERT_LABELS, valuesQuestions } from '../services/values/questions';
import { VectorService } from '../services/VectorService';
import { generateCompactToken } from '../services/SnapService';
import { anon_id, anon_fid } from '../../src/lib/consts';
import { classifyForRegistration, type RegistrationTaxonomyStatus } from '../services/taxonomy/registerClassify';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

interface StepResult {
  questionId: string;
  type: 'likert' | 'forced' | 'open';
  query: 'inserted' | 'skipped' | 'error';
  vector: 'inserted' | 'skipped' | 'error';
  cast: 'inserted' | 'skipped' | 'error';
  castHash?: string;
  taxonomy?: RegistrationTaxonomyStatus;
  error?: string;
}

export async function handleAdminRegisterValuesQueries(
  request: Request,
  env: Env
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/api/admin/register-values-queries' || request.method !== 'POST') {
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

  for (const q of valuesQuestions) {
    const r: StepResult = {
      questionId: q.id,
      type: q.type,
      query: 'skipped',
      vector: 'skipped',
      cast: 'skipped',
    };

    try {
      // Per-type derivations.
      let answerTypeId: 'scale' | 'mc' | 'text';
      let optionLabels: string[];
      let aOptionsJson: string | null;
      let scaleConfigJson: string | null;
      let isTemplate: boolean;

      if (q.type === 'likert') {
        answerTypeId = 'scale';
        // Likert is rendered by scaleQuestionToSnap, which reads scale_config
        // (min/max/customLabels). a_options is unused for scale type.
        optionLabels = [];
        aOptionsJson = null;
        scaleConfigJson = JSON.stringify({
          min: 1,
          max: 5,
          customLabels: LIKERT_LABELS.map((label, i) => ({ value: i + 1, label })),
        });
        // Likert stems carry the meaning; the 5 anchor labels are identical
        // across all items, so they don't add discriminating signal — embed
        // stem only.
        isTemplate = false;
      } else if (q.type === 'forced') {
        answerTypeId = 'mc';
        optionLabels = q.a_options.map((o) => o.label);
        aOptionsJson = JSON.stringify(optionLabels);
        scaleConfigJson = null;
        // Forced-choice options carry meaning (mirrors bartlet's mc embed).
        isTemplate = true;
      } else {
        // open
        answerTypeId = 'text';
        optionLabels = [];
        aOptionsJson = null;
        scaleConfigJson = null;
        isTemplate = false;
      }

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
            ?, ?, ?, ?, ?, NULL, 0, ?,
            ?, ?, '4n0n', ?,
            NULL, NULL, NULL, NULL, NULL, NULL, 0, ?,
            NULL,
            0, 0, 0
          )`
        ).bind(
          q.id,
          q.stem,
          answerTypeId,
          aOptionsJson,
          scaleConfigJson,
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
        const embeddingText = vectorService.generateEmbeddingText(
          q.stem,
          optionLabels.length > 0 ? optionLabels : undefined,
          isTemplate
        );
        const vector = await vectorService.vectorize(embeddingText);
        await vectorService.addVectors(
          [
            {
              id: q.id,
              values: vector,
              metadata: {
                stem: q.stem,
                text: q.stem,
                type: answerTypeId,
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
        const compactToken = await generateCompactToken(q.id, env.QBASE_SECRET);
        const embedUrl = `${baseUrl}/snap/question/${q.id}?compact=1&token=${compactToken}`;

        const cast = await hypersnap.publishCast({
          signerKey: anonSignerKey,
          fid: anon_fid,
          text: q.stem,
          embeds: [{ url: embedUrl }],
        });

        await FarcasterDBService.upsertCast(env.DB, {
          entity_type: 'query',
          entity_id: q.id,
          cast_hash: cast.hash,
          cast_url: `https://farcaster.xyz/4n0n/${cast.hash}`,
          caster_fid: anon_fid,
        });

        await env.DB.prepare(
          `INSERT INTO question_meta
             (question_id, cast_hash, cast_status, author_fid, is_anon,
              answer_type_id, value_schema, topic_id, canonical_id, forked_from,
              created_at, updated_at)
           VALUES (?, ?, 'active', ?, 1, ?, NULL, NULL, NULL, NULL, ?, ?)`
        ).bind(q.id, cast.hash, anon_fid, answerTypeId, nowMs, nowMs).run();

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
        query: r.query === 'inserted' ? r.query : 'error',
        error: msg,
      });
    }
  }

  const tally = (key: 'query' | 'vector' | 'cast') => ({
    inserted: results.filter((res) => res[key] === 'inserted').length,
    skipped: results.filter((res) => res[key] === 'skipped').length,
    errors: results.filter((res) => res[key] === 'error').length,
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
