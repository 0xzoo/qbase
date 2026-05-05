/**
 * VectorReconciler — backfill missing Vectorize entries for recently-created queries.
 *
 * Question creation writes the vector index entry asynchronously via ctx.waitUntil
 * (see worker/handlers/queries.ts), so a flaky Vectorize write can leave a query
 * row in D1 without a corresponding vector. That row would silently bypass
 * duplicate-detection for any future question — this sweep catches and re-indexes
 * those orphans.
 *
 * Wired into the hourly cron in worker/index.ts. Bounded scan over the last
 * RECONCILE_LOOKBACK_MS to keep cost flat.
 */

import { VectorService } from './VectorService';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

const RECONCILE_LOOKBACK_MS = 6 * 60 * 60 * 1000; // 6 hours
const BATCH_LIMIT = 100;

export async function reconcileMissingVectors(env: Env): Promise<{
  scanned: number;
  missing: number;
  reindexed: number;
  errors: number;
}> {
  const stats = { scanned: 0, missing: 0, reindexed: 0, errors: 0 };
  const cutoffIso = new Date(Date.now() - RECONCILE_LOOKBACK_MS).toISOString();

  const { results } = await env.DB.prepare(
    `SELECT id, stem, type, a_options, coiner_id, coiner_fid, coiner_fname, created_at, taxonomy
     FROM queries
     WHERE created_at >= ?
     ORDER BY created_at DESC
     LIMIT ?`
  ).bind(cutoffIso, BATCH_LIMIT).all() as {
    results: Array<{
      id: string;
      stem: string;
      type: string;
      a_options: string | null;
      coiner_id: string;
      coiner_fid: number | null;
      coiner_fname: string | null;
      created_at: string;
      taxonomy: string | null;
    }>;
  };

  if (!results.length) return stats;
  stats.scanned = results.length;

  const vectorService = VectorService.fromEnv(env);
  const ids = results.map(r => r.id);

  // Probe Vectorize for which IDs are already present
  let present = new Set<string>();
  try {
    const existing = await vectorService.getVectorsByIds(ids, 'q');
    present = new Set(existing.map(v => v.id));
  } catch (err) {
    console.error('[VectorReconciler] getByIds probe failed:', err);
    stats.errors++;
    return stats;
  }

  const missing = results.filter(r => !present.has(r.id));
  stats.missing = missing.length;
  if (!missing.length) return stats;

  for (const row of missing) {
    try {
      const options: string[] | undefined = row.a_options ? JSON.parse(row.a_options) : undefined;
      const taxonomy = row.taxonomy ? JSON.parse(row.taxonomy) : null;
      const isTemplate = taxonomy?.is_template === true;

      const text = vectorService.generateEmbeddingText(row.stem, options, isTemplate);
      const values = await vectorService.vectorize(text);

      await vectorService.addVectors([{
        id: row.id,
        values,
        metadata: {
          stem: row.stem,
          text: row.stem,
          type: row.type,
          created_at: row.created_at,
          coiner_id: row.coiner_id,
          coiner_fid: row.coiner_fid,
          coiner_fname: row.coiner_fname,
          options_count: options?.length || 0,
        },
      }], 'q');

      stats.reindexed++;
      console.log(`[VectorReconciler] Reindexed ${row.id}`);
    } catch (err) {
      stats.errors++;
      console.error(`[VectorReconciler] Failed to reindex ${row.id}:`, err);
    }
  }

  return stats;
}
