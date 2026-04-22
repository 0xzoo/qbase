/**
 * ReconcilerService — Phase 2 of Hypersnap data layer migration.
 *
 * Runs on a cron (every minute). Scans `pending_cast_index WHERE reconciled = 0`
 * and aligns rows with `question_meta` per the five-case reconciliation matrix:
 *
 *   Case 1: question_id unparseable from embed → flag for manual triage.
 *   Case 2a: question_meta exists, cast_hash matches → mark reconciled.
 *   Case 2b: cast_hash differs, status='active' → duplicate cast; delete newer
 *            if qbase-authored, keep earlier.
 *   Case 2c: cast_hash differs, status ∈ {republished, deleted} → transitional;
 *            verify via question_cast_history.
 *   Case 3a: orphan, author is our bot signer → reconstruct question_meta from cast.
 *   Case 3b: orphan, external cast with our embed URL → flag for triage.
 *
 * Also handles answer-side reconciliation: reply casts whose parent_hash matches
 * a known question_meta.cast_hash are reconciled as public answers.
 *
 * See: docs/hypersnap/data-layer.md § Indexer & Reconciliation Pipeline.
 */

import { createHypersnapService, type HypersnapService, type HypersnapCast } from './HypersnapService';

type Env = any;

// Bot FIDs — must match wrangler.jsonc vars
const BOT_FIDS = [514282, 975961]; // 4n0n + Q

// Max rows per cron tick
const BATCH_LIMIT = 100;

/**
 * Run a single reconciliation pass over unreconciled pending_cast_index rows.
 * Returns summary counts for logging.
 */
export async function runReconciler(env: Env): Promise<{
  processed: number;
  reconciled: number;
  flagged: number;
  deleted: number;
  errors: number;
}> {
  const stats = { processed: 0, reconciled: 0, flagged: 0, deleted: 0, errors: 0 };
  const now = Date.now();

  // Pull unreconciled batch
  const { results: rows } = await env.DB.prepare(
    `SELECT cast_hash, question_id, author_fid, cast_text, parent_hash
     FROM pending_cast_index WHERE reconciled = 0
     ORDER BY first_seen_at ASC LIMIT ?`,
  ).bind(BATCH_LIMIT).all() as { results: PendingRow[] };

  if (!rows.length) return stats;

  // Hypersnap service for reads + duplicate deletion
  const signerKey: string | undefined = env.QGENT_SIGNER_KEY;
  const qgentFid: number = Number(env.QGENT_FID) || 975961;
  let hypersnap: HypersnapService | null = null;
  try {
    hypersnap = createHypersnapService(env);
  } catch {
    // HYPERSNAP_ENDPOINT not configured — reads will fail but we still process D1-only logic
    console.warn('[Reconciler] HypersnapService init failed (endpoint missing?)');
  }

  for (const row of rows) {
    stats.processed++;
    try {
      await reconcileRow(row, env, hypersnap, signerKey, qgentFid, now, stats);
    } catch (err) {
      stats.errors++;
      console.error(`[Reconciler] Error processing ${row.cast_hash}:`, err);
      // Update last_attempt_at but leave unreconciled for retry
      await env.DB.prepare(
        'UPDATE pending_cast_index SET last_attempt_at = ?, notes = ? WHERE cast_hash = ?',
      ).bind(now, `error: ${String((err as Error).message).slice(0, 200)}`, row.cast_hash).run();
    }
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Per-row reconciliation
// ---------------------------------------------------------------------------

async function reconcileRow(
  row: PendingRow,
  env: Env,
  hypersnap: HypersnapService | null,
  signerKey: string | undefined,
  qgentFid: number,
  now: number,
  stats: { reconciled: number; flagged: number; deleted: number },
): Promise<void> {
  // ── Case 1: question_id unparseable ──
  if (!row.question_id) {
    // Could be a reply to a known question (answer-side) or a truly unparseable cast
    if (row.parent_hash) {
      const reconciled = await tryReconcileAnswer(row, env, now);
      if (reconciled) {
        stats.reconciled++;
        return;
      }
    }
    await flagRow(env, row.cast_hash, 'unparseable embed URL', now);
    stats.flagged++;
    return;
  }

  // ── Cases 2a/2b/2c: question_meta exists ──
  const meta = await env.DB.prepare(
    'SELECT question_id, cast_hash, cast_status, author_fid, is_anon, answer_type_id, value_schema, topic_id, canonical_id, created_at FROM question_meta WHERE question_id = ?',
  ).bind(row.question_id).first() as QuestionMeta | null;

  if (meta) {
    await reconcileExisting(row, meta, env, hypersnap, signerKey, qgentFid, now, stats);
    return;
  }

  // ── Cases 3a/3b: orphan — no question_meta ──
  await reconcileOrphan(row, env, hypersnap, signerKey, qgentFid, now, stats);
}

// ---------------------------------------------------------------------------
// Case 2: question_meta exists
// ---------------------------------------------------------------------------

async function reconcileExisting(
  row: PendingRow,
  meta: QuestionMeta,
  env: Env,
  hypersnap: HypersnapService | null,
  signerKey: string | undefined,
  qgentFid: number,
  now: number,
  stats: { reconciled: number; flagged: number; deleted: number },
): Promise<void> {
  // Case 2a: exact match — already reconciled at write time
  if (meta.cast_hash === row.cast_hash) {
    await markReconciled(env, row.cast_hash);
    stats.reconciled++;
    return;
  }

  // Case 2b: cast_hash differs, status='active' → duplicate cast
  if (meta.cast_status === 'active') {
    const isBotAuthor = BOT_FIDS.includes(row.author_fid);
    if (isBotAuthor && hypersnap && signerKey) {
      // Delete the duplicate (newer) cast — we keep the earlier one in question_meta
      try {
        await hypersnap.deleteCast({
          signerKey,
          fid: qgentFid,
          castHash: row.cast_hash,
        });
        stats.deleted++;
        console.log(`[Reconciler] Deleted duplicate cast ${row.cast_hash} for question ${meta.question_id}`);
      } catch (delErr) {
        console.error(`[Reconciler] Failed to delete duplicate ${row.cast_hash}:`, delErr);
      }
    }
    await markReconciled(env, row.cast_hash, 'duplicate cast detected');
    stats.reconciled++;
    return;
  }

  // Case 2c: cast_hash differs, status ∈ {republished, deleted}
  // Transitional state — verify via question_cast_history
  const hist = await env.DB.prepare(
    'SELECT 1 FROM question_cast_history WHERE question_id = ? AND cast_hash = ? LIMIT 1',
  ).bind(meta.question_id, row.cast_hash).first();

  if (hist) {
    // Expected anchor from a re-anchor flow
    await markReconciled(env, row.cast_hash, `transitional: ${meta.cast_status} (verified in history)`);
    stats.reconciled++;
  } else {
    // Not in history — unexpected hash for a non-active question
    await flagRow(env, row.cast_hash,
      `cast_hash mismatch: meta has ${meta.cast_hash} (status=${meta.cast_status}) but pending has ${row.cast_hash}, not in history`,
      now,
    );
    stats.flagged++;
  }
}

// ---------------------------------------------------------------------------
// Case 3: orphan — no question_meta
// ---------------------------------------------------------------------------

async function reconcileOrphan(
  row: PendingRow,
  env: Env,
  hypersnap: HypersnapService | null,
  _signerKey: string | undefined,
  _qgentFid: number,
  now: number,
  stats: { reconciled: number; flagged: number; deleted: number },
): Promise<void> {
  // Fetch the cast to get full data for reconstruction
  let cast: HypersnapCast | null = null;
  if (hypersnap) {
    try {
      cast = await hypersnap.getCastByHash(row.cast_hash);
    } catch (e) {
      console.warn(`[Reconciler] getCastByHash failed for ${row.cast_hash}:`, e);
    }
  }

  // Case 3a: orphan reply to a known question (answer-side)
  if (row.parent_hash && !row.question_id) {
    const parent = await env.DB.prepare(
      'SELECT question_id FROM question_meta WHERE cast_hash = ? LIMIT 1',
    ).bind(row.parent_hash).first() as { question_id: string } | null;

    if (parent) {
      const reconciled = await tryReconcileAnswer(row, env, now);
      if (reconciled) {
        stats.reconciled++;
        return;
      }
    }
  }

  // Case 3a: orphan authored by our bot → reconstruct question_meta
  if (BOT_FIDS.includes(row.author_fid)) {
    await reconstructQuestionMeta(row, cast, env, now, stats);
    return;
  }

  // Case 3b: external cast with our embed URL → flag for triage
  await flagRow(env, row.cast_hash,
    `orphan: external cast (author_fid=${row.author_fid}) with qbase embed, no question_meta`,
    now,
  );
  stats.flagged++;
}

/**
 * Attempt to reconstruct a question_meta row from a bot-authored orphan cast.
 * Only possible if we can extract a valid question_id from the embed URL.
 */
async function reconstructQuestionMeta(
  row: PendingRow,
  cast: HypersnapCast | null,
  env: Env,
  now: number,
  stats: { reconciled: number; flagged: number },
): Promise<void> {
  // We need a question_id — try from the row first, then from the cast embeds
  let questionId = row.question_id;

  if (!questionId && cast) {
    // Re-extract from embeds
    for (const embed of cast.embeds ?? []) {
      if (!embed.url) continue;
      const id = parseQuestionIdFromUrl(embed.url, 'qbase.tech');
      if (id) { questionId = id; break; }
    }
    // Also try from cast text
    if (!questionId && cast.text) {
      const match = cast.text.match(/https?:\/\/qbase\.tech\/q\/([A-Za-z0-9_-]+)/);
      if (match) questionId = match[1];
    }
  }

  if (!questionId) {
    await flagRow(env, row.cast_hash,
      `orphan bot cast: cannot extract question_id from embed or text`,
      now,
    );
    stats.flagged++;
    return;
  }

  // Check if another reconciler pass already created this question
  const existing = await env.DB.prepare(
    'SELECT 1 FROM question_meta WHERE question_id = ? LIMIT 1',
  ).bind(questionId).first();

  if (existing) {
    // Race condition: another pass created it — just mark reconciled
    await markReconciled(env, row.cast_hash, 'orphan resolved: question_meta created by concurrent pass');
    stats.reconciled++;
    return;
  }

  // Reconstruct: insert question_meta with defaults + seed cache
  const anonFid = Number(env.ANON_FID) || 514282;
  const isAnon = row.author_fid === anonFid ? 1 : 0;

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO question_meta (question_id, cast_hash, cast_status, author_fid, is_anon, answer_type_id, value_schema, topic_id, canonical_id, created_at, updated_at)
       VALUES (?, ?, 'active', ?, ?, 'text', NULL, NULL, NULL, ?, ?)`,
    ).bind(questionId, row.cast_hash, row.author_fid, isAnon, now, now),
    env.DB.prepare(
      `INSERT INTO cast_stats_cache (cast_hash, reply_count, like_count, recast_count, refreshed_at)
       VALUES (?, 0, 0, 0, ?)`,
    ).bind(row.cast_hash, now),
    env.DB.prepare(
      'UPDATE pending_cast_index SET reconciled = 1, notes = ? WHERE cast_hash = ?',
    ).bind('reconstructed from orphan bot cast', row.cast_hash),
  ]);

  console.log(`[Reconciler] Reconstructed question_meta for ${questionId} from orphan cast ${row.cast_hash}`);
  stats.reconciled++;
}

// ---------------------------------------------------------------------------
// Answer-side reconciliation
// ---------------------------------------------------------------------------

/**
 * Try to reconcile a pending cast as a public answer (reply to a known question).
 * Returns true if successfully reconciled.
 */
async function tryReconcileAnswer(row: PendingRow, env: Env, now: number): Promise<boolean> {
  // Find the parent question
  const parent = await env.DB.prepare(
    'SELECT question_id FROM question_meta WHERE cast_hash = ? LIMIT 1',
  ).bind(row.parent_hash!).first() as { question_id: string } | null;

  if (!parent) return false;

  // Check if answer_meta already exists (from the write path)
  const existingAnswer = await env.DB.prepare(
    'SELECT id, reply_cast_hash FROM answer_meta WHERE reply_cast_hash = ? LIMIT 1',
  ).bind(row.cast_hash).first() as { id: string; reply_cast_hash: string | null } | null;

  if (existingAnswer && existingAnswer.reply_cast_hash) {
    // Already known — mark pending cast index reconciled
    await markReconciled(env, row.cast_hash, 'answer already tracked in answer_meta');
    return true;
  }

  // Organic reply from Farcaster (not submitted through qbase write path)
  // Create a minimal answer_meta entry
  const answerId = `reconciled-${row.cast_hash.slice(2, 12)}-${Date.now()}`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO answer_meta (id, question_id, reply_cast_hash, replied_to_hash, responder_fid, privacy_tier, created_at)
       VALUES (?, ?, ?, ?, ?, 'public', ?)`,
    ).bind(answerId, parent.question_id, row.cast_hash, row.parent_hash, row.author_fid, now),
    env.DB.prepare(
      'UPDATE pending_cast_index SET reconciled = 1, notes = ? WHERE cast_hash = ?',
    ).bind('reconciled as organic public answer', row.cast_hash),
  ]);

  console.log(`[Reconciler] Reconciled organic answer ${row.cast_hash} → question ${parent.question_id}`);
  return true;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function markReconciled(env: Env, castHash: string, notes?: string): Promise<void> {
  await env.DB.prepare(
    'UPDATE pending_cast_index SET reconciled = 1, notes = ? WHERE cast_hash = ?',
  ).bind(notes ?? null, castHash).run();
}

async function flagRow(env: Env, castHash: string, reason: string, now: number): Promise<void> {
  await env.DB.prepare(
    'UPDATE pending_cast_index SET notes = ?, last_attempt_at = ? WHERE cast_hash = ?',
  ).bind(reason, now, castHash).run();
}

function parseQuestionIdFromUrl(urlStr: string, embedHost: string): string | null {
  try {
    const u = new URL(urlStr);
    if (u.hostname !== embedHost) return null;
    if (!u.pathname.startsWith('/q/')) return null;
    const id = u.pathname.slice(3).split('/')[0];
    return id || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PendingRow {
  cast_hash: string;
  question_id: string | null;
  author_fid: number;
  cast_text: string | null;
  parent_hash: string | null;
}

interface QuestionMeta {
  question_id: string;
  cast_hash: string | null;
  cast_status: string;
  author_fid: number;
  is_anon: number;
  answer_type_id: string;
  value_schema: string | null;
  topic_id: string | null;
  canonical_id: string | null;
  created_at: number;
}
