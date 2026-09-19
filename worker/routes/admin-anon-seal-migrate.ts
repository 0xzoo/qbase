/**
 * admin-anon-seal-migrate — move the anon tier to "sealed to Q" (card
 * t_9f2869db; migration 0072 reshapes the table, this route moves the data).
 *
 * POST /api/admin/anon-seal-migrate
 *   { phase: 'status' | 'answers' | 'attributions' | 'unseal',
 *     dryRun?: boolean,        // count and report, write nothing
 *     limit?: number }         // rows per call (default 50, max 200)
 *
 * Phases (each idempotent — its selector excludes what it has done):
 *   status        counts: Anon rows still carrying an author, legacy
 *                 attribution rows (author_id set), sealed rows, and whether
 *                 the tag key and the KEK are ready.
 *   answers       every Anon row of `Answers` whose user_id is a real FID:
 *                 write (or seal) its attribution from that FID, then set
 *                 user_id and answer_meta.responder_fid to the @4n0n
 *                 placeholder and quiz_completion_id to NULL. Rows already on
 *                 the legacy placeholder (3) are moved to the current one;
 *                 they have no author to seal.
 *   attributions  every attribution row with author_id set (questions, and
 *                 answers written before this sweep): compute author_tag and
 *                 author_ct, NULL author_id. Scope is the question id: the
 *                 row's own public_id for a question, Answers.q_id for an
 *                 answer (an answer whose row is gone is deleted).
 *   unseal        the rollback: author_id restored from author_ct on every
 *                 sealed row (Answers rows are not touched — the FID is still
 *                 only in the attribution). Operator use only.
 *
 * Runs inside the Worker so neither the tag key nor the KEK leaves it.
 * Auth: X-Admin-Secret header must match env.QBASE_ADMIN_SECRET.
 */

import { SecretBox } from '../services/secret/SecretBox';
import { anonPlaceholderFid, anonTag, anonTagReady, attributionCtx, LEGACY_ANON_USER_ID } from '../services/anon/AnonTag';
import { attributionStatement, openAuthorFid } from '../services/AnonAttributionService';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

type Phase = 'status' | 'answers' | 'attributions' | 'unseal';

interface Report {
  phase: Phase;
  dryRun: boolean;
  processed: number;
  sealed: number;
  rewritten: number;
  deleted: number;
  errors: Array<{ id: string; error: string }>;
  done: boolean;
  note?: string;
}

function newReport(phase: Phase, dryRun: boolean): Report {
  return { phase, dryRun, processed: 0, sealed: 0, rewritten: 0, deleted: 0, errors: [], done: false };
}

async function status(env: Env) {
  const placeholder = anonPlaceholderFid(env);
  const row = await env.DB.prepare(`
    SELECT
      (SELECT COUNT(*) FROM Answers WHERE audience = 'Anon' AND user_id NOT IN (?, ?)) AS anon_rows_with_author,
      (SELECT COUNT(*) FROM Answers WHERE audience = 'Anon' AND user_id = ?) AS anon_rows_legacy_placeholder,
      (SELECT COUNT(*) FROM Answers WHERE audience = 'Anon' AND quiz_completion_id IS NOT NULL) AS anon_rows_linked_to_completion,
      (SELECT COUNT(*) FROM answer_meta m JOIN Answers a ON a.id = m.id WHERE a.audience = 'Anon' AND m.responder_fid NOT IN (?, ?)) AS anon_meta_with_author,
      (SELECT COUNT(*) FROM anon_attributions WHERE author_id IS NOT NULL) AS attributions_legacy,
      (SELECT COUNT(*) FROM anon_attributions WHERE author_tag IS NOT NULL AND author_ct IS NOT NULL) AS attributions_sealed,
      (SELECT COUNT(*) FROM anon_attributions) AS attributions_total,
      (SELECT COUNT(*) FROM Answers WHERE audience = 'Anon') AS anon_rows_total
  `).bind(placeholder, LEGACY_ANON_USER_ID, LEGACY_ANON_USER_ID, placeholder, LEGACY_ANON_USER_ID).first();
  return {
    ...(row as Record<string, number>),
    placeholder_fid: placeholder,
    tag_key_ready: await anonTagReady(env),
    kek_ready: await SecretBox.isReady(env),
  };
}

async function answersPhase(env: Env, dryRun: boolean, limit: number): Promise<Report> {
  const report = newReport('answers', dryRun);
  const placeholder = anonPlaceholderFid(env);
  const { results } = await env.DB.prepare(`
    SELECT id, q_id, user_id, quiz_completion_id, created_at FROM Answers
    WHERE audience = 'Anon' AND user_id != ?
    ORDER BY created_at ASC LIMIT ?
  `).bind(placeholder, limit).all();
  const rows = (results ?? []) as Array<{ id: string; q_id: string; user_id: number; quiz_completion_id: string | null; created_at: string }>;
  for (const r of rows) {
    report.processed++;
    try {
      const hasAuthor = Number(r.user_id) !== LEGACY_ANON_USER_ID;
      if (dryRun) {
        if (hasAuthor) report.sealed++;
        report.rewritten++;
        continue;
      }
      const stmts = [];
      if (hasAuthor) {
        stmts.push(await attributionStatement(env, {
          public_id: r.id, fid: Number(r.user_id), type: 'answer', scope_id: r.q_id, created_at: r.created_at,
        }));
      }
      stmts.push(env.DB.prepare(
        'UPDATE Answers SET user_id = ?, quiz_completion_id = NULL WHERE id = ?',
      ).bind(placeholder, r.id));
      stmts.push(env.DB.prepare(
        'UPDATE answer_meta SET responder_fid = ? WHERE id = ?',
      ).bind(placeholder, r.id));
      await env.DB.batch(stmts);
      if (hasAuthor) report.sealed++;
      report.rewritten++;
    } catch (e) {
      report.errors.push({ id: r.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  // answer_meta rows whose Answers row already carries the placeholder but whose meta still names the person
  if (!dryRun) {
    const meta = await env.DB.prepare(`
      UPDATE answer_meta SET responder_fid = ?
      WHERE id IN (SELECT a.id FROM Answers a WHERE a.audience = 'Anon') AND responder_fid != ?
    `).bind(placeholder, placeholder).run();
    const changed = Number(meta?.meta?.changes ?? 0);
    if (changed) report.note = `answer_meta.responder_fid rewritten on ${changed} further row(s)`;
  }
  report.done = rows.length < limit && report.errors.length === 0;
  return report;
}

async function attributionsPhase(env: Env, dryRun: boolean, limit: number): Promise<Report> {
  const report = newReport('attributions', dryRun);
  const { results } = await env.DB.prepare(`
    SELECT t.id, t.public_id, t.author_id, t.type, t.created_at, a.q_id AS answer_q_id
    FROM anon_attributions t
    LEFT JOIN Answers a ON a.id = t.public_id AND t.type = 'answer'
    WHERE t.author_id IS NOT NULL
    ORDER BY t.created_at ASC LIMIT ?
  `).bind(limit).all();
  const rows = (results ?? []) as Array<{ id: string; public_id: string; author_id: number; type: 'question' | 'answer' | 'direct_query'; created_at: string; answer_q_id: string | null }>;
  for (const r of rows) {
    report.processed++;
    try {
      const scope = r.type === 'answer' ? r.answer_q_id : r.public_id;
      if (!scope) {
        // an answer attribution whose row is gone: nothing to own
        if (!dryRun) await env.DB.prepare('DELETE FROM anon_attributions WHERE id = ?').bind(r.id).run();
        report.deleted++;
        continue;
      }
      if (dryRun) {
        report.sealed++;
        continue;
      }
      await (await attributionStatement(env, {
        public_id: r.public_id, fid: Number(r.author_id), type: r.type, scope_id: scope, created_at: r.created_at,
      })).run();
      report.sealed++;
    } catch (e) {
      report.errors.push({ id: r.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  report.done = rows.length < limit && report.errors.length === 0;
  return report;
}

async function unsealPhase(env: Env, dryRun: boolean, limit: number): Promise<Report> {
  const report = newReport('unseal', dryRun);
  const { results } = await env.DB.prepare(`
    SELECT id, public_id FROM anon_attributions
    WHERE author_ct IS NOT NULL AND author_id IS NULL
    ORDER BY created_at ASC LIMIT ?
  `).bind(limit).all();
  const rows = (results ?? []) as Array<{ id: string; public_id: string }>;
  for (const r of rows) {
    report.processed++;
    try {
      const fid = await openAuthorFid(env, r.public_id);
      if (fid === null) throw new Error('envelope opened to no FID');
      if (!dryRun) {
        await env.DB.prepare('UPDATE anon_attributions SET author_id = ? WHERE id = ?').bind(fid, r.id).run();
      }
      report.rewritten++;
    } catch (e) {
      report.errors.push({ id: r.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  report.done = rows.length < limit && report.errors.length === 0;
  return report;
}

export async function handleAdminAnonSealMigrate(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/api/admin/anon-seal-migrate' || request.method !== 'POST') return null;
  if (!env.QBASE_ADMIN_SECRET || request.headers.get('X-Admin-Secret') !== env.QBASE_ADMIN_SECRET) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }
  let body: { phase?: Phase; dryRun?: boolean; limit?: number } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }
  const phase: Phase = body.phase ?? 'status';
  const dryRun = body.dryRun === true;
  const limit = Math.min(200, Math.max(1, Number(body.limit) || 50));
  try {
    if (phase === 'status') return Response.json(await status(env));
    if (phase !== 'unseal' && !(await anonTagReady(env))) {
      return Response.json({ error: 'ANON_TAG_KEY is not configured' }, { status: 503 });
    }
    if (!(await SecretBox.isReady(env))) {
      return Response.json({ error: 'ANSWER_KEKS is not configured' }, { status: 503 });
    }
    if (phase === 'answers') return Response.json(await answersPhase(env, dryRun, limit));
    if (phase === 'attributions') return Response.json(await attributionsPhase(env, dryRun, limit));
    if (phase === 'unseal') return Response.json(await unsealPhase(env, dryRun, limit));
    return Response.json({ error: `unknown phase ${String(phase)}` }, { status: 400 });
  } catch (e) {
    console.error('[anon-seal-migrate] failed:', e);
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

/** Exposed for tests: the AAD an attribution envelope is bound to. */
export { attributionCtx, anonTag };
