/**
 * admin-secret-migrate — seal what is already stored, and rotate keys.
 *
 * Spec: docs/specs/private-answer-encryption.md §7.8 (rotation), §7.9 (migration).
 *
 * POST /api/admin/secret-migrate
 *   { phase: 'status' | 'answers' | 'completions' | 'sessions' | 'rewrap',
 *     dryRun?: boolean,          // count and report, write nothing
 *     limit?: number,            // rows / objects per call (default 25, max 100)
 *     cursor?: string,           // from the previous response's nextCursor
 *     target?: 'completions' | 'answers' | 'sessions' }   // rewrap only (default completions)
 *
 * Phases:
 *   status       readiness of ANSWER_KEKS (names only), legacy vs sealed counts,
 *                kid distribution, whether the bucket supports listing.
 *   answers      Answers rows with a storage_ref: legacy plaintext blob → sealed
 *                (D1 answer_data content merged in), then reasoning / topics /
 *                content keys of answer_data NULLed on the row.
 *   completions  quiz_completions with a plaintext snapshot and non-public
 *                visibility → answers_encrypted sealed, answers_snapshot NULL.
 *   sessions     bucket listing under the four quiz prefixes: live sessions
 *                (KV session:<sid> exists) re-sealed in place; orphans deleted
 *                (decision §12.4). Reports `list_unsupported` if the bucket
 *                refuses ListObjectsV2 (§4).
 *   rewrap       every sealed object / row whose kid is not current: DEK
 *                re-wrapped, body untouched (§7.8).
 *
 * Batched, cursor-driven, idempotent: each phase's query excludes what it has
 * already done, so re-running after a partial failure is safe. Runs inside the
 * Worker so the KEK never leaves it.
 *
 * Auth: X-Admin-Secret header must match env.QBASE_ADMIN_SECRET.
 */

import { SecretBox } from '../services/secret/SecretBox';
import { SecretStore } from '../services/secret/SecretStore';
import { QStorageService } from '../services/QStorageService';
import { parseAnswerData, storageKeyOf, stripAnswerDataContent } from '../handlers/answers/shared';
import { completionCtx } from './quiz-completions';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

type Phase = 'status' | 'answers' | 'completions' | 'sessions' | 'rewrap';
type RewrapTarget = 'completions' | 'answers' | 'sessions';

interface MigrateBody {
  phase?: Phase;
  dryRun?: boolean;
  limit?: number;
  cursor?: string;
  target?: RewrapTarget;
}

interface Report {
  phase: Phase;
  dryRun: boolean;
  processed: number;
  sealed: number;
  alreadySealed: number;
  rewrapped: number;
  d1Cleared: number;
  orphansDeleted: number;
  missing: number;
  errors: Array<{ id: string; error: string }>;
  nextCursor: string | null;
  done: boolean;
  note?: string;
}

const SESSION_PREFIXES: Array<{ prefix: string; kv: string; quiz: string }> = [
  { prefix: 'bartlet/answers/', kv: 'BARTLET_SESSIONS', quiz: 'bartlet' },
  { prefix: 'values/answers/', kv: 'VALUES_SESSIONS', quiz: 'values' },
  { prefix: 'apperception/answers/', kv: 'APPERCEPTION_SESSIONS', quiz: 'apperception' },
  { prefix: 'caslate/answers/', kv: 'CA_SLATE_SESSIONS', quiz: 'ca-slate' },
];

const CONTENT_KEYS = ['index', 'indices', 'text', 'value', 'iso'];

function newReport(phase: Phase, dryRun: boolean): Report {
  return {
    phase, dryRun, processed: 0, sealed: 0, alreadySealed: 0, rewrapped: 0,
    d1Cleared: 0, orphansDeleted: 0, missing: 0, errors: [], nextCursor: null, done: false,
  };
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function rowHasD1Content(row: { reasoning?: unknown; topics?: unknown; answer_data?: unknown }): boolean {
  if (row.reasoning != null || row.topics != null) return true;
  const data = parseAnswerData(row.answer_data);
  return !!data && CONTENT_KEYS.some(k => k in data);
}

export async function handleAdminSecretMigrate(
  request: Request,
  env: Env
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/api/admin/secret-migrate' || request.method !== 'POST') {
    return null;
  }

  const secret = request.headers.get('X-Admin-Secret');
  if (!env.QBASE_ADMIN_SECRET || secret !== env.QBASE_ADMIN_SECRET) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }

  let body: MigrateBody;
  try {
    body = (await request.json()) as MigrateBody;
  } catch {
    return Response.json({ error: 'JSON body required' }, { status: 400 });
  }

  const phase = body.phase ?? 'status';
  const dryRun = !!body.dryRun;
  const limit = Math.max(1, Math.min(100, Number(body.limit) || 25));
  const cursor = typeof body.cursor === 'string' ? body.cursor : '';

  try {
    switch (phase) {
      case 'status':
        return Response.json(await status(env));
      case 'answers':
        return Response.json(await migrateAnswers(env, { dryRun, limit, cursor }));
      case 'completions':
        return Response.json(await migrateCompletions(env, { dryRun, limit, cursor }));
      case 'sessions':
        return Response.json(await migrateSessions(env, { dryRun, limit, cursor }));
      case 'rewrap':
        return Response.json(await rewrap(env, { dryRun, limit, cursor, target: body.target ?? 'completions' }));
      default:
        return Response.json({ error: `Unknown phase "${String(phase)}"` }, { status: 400 });
    }
  } catch (e) {
    console.error('[secret-migrate] failed:', e);
    return Response.json({ error: errorText(e), phase }, { status: 500 });
  }
}

// ─── status ────────────────────────────────────────────────────────────────

async function status(env: Env) {
  const ready = await SecretBox.assertReady(env)
    .then(info => ({ ok: true as const, ...info }))
    .catch(e => ({ ok: false as const, error: errorText(e) }));

  const completions = await env.DB.prepare(`
    SELECT
      SUM(CASE WHEN answers_snapshot IS NOT NULL AND visibility != 'public' THEN 1 ELSE 0 END) AS legacy_plaintext,
      SUM(CASE WHEN answers_encrypted IS NOT NULL THEN 1 ELSE 0 END) AS sealed,
      SUM(CASE WHEN visibility = 'public' THEN 1 ELSE 0 END) AS public,
      COUNT(*) AS total
    FROM quiz_completions
  `).first();

  let completionsByKid: unknown = null;
  try {
    const r = await env.DB.prepare(`
      SELECT json_extract(answers_encrypted, '$.kid') AS kid, COUNT(*) AS n
      FROM quiz_completions WHERE answers_encrypted IS NOT NULL GROUP BY kid
    `).all();
    completionsByKid = r.results;
  } catch (e) {
    completionsByKid = { error: errorText(e) };
  }

  let answers: unknown = null;
  try {
    answers = await env.DB.prepare(`
      SELECT
        COUNT(*) AS sealed_tier_rows,
        SUM(CASE WHEN storage_ref IS NOT NULL THEN 1 ELSE 0 END) AS with_ref,
        SUM(CASE WHEN reasoning IS NOT NULL OR topics IS NOT NULL
                   OR json_extract(answer_data, '$.index') IS NOT NULL
                   OR json_extract(answer_data, '$.indices') IS NOT NULL
                   OR json_extract(answer_data, '$.text') IS NOT NULL
                   OR json_extract(answer_data, '$.value') IS NOT NULL
                   OR json_extract(answer_data, '$.iso') IS NOT NULL
                 THEN 1 ELSE 0 END) AS d1_content
      FROM Answers WHERE audience IN ('Private', 'Allowlist')
    `).first();
  } catch (e) {
    answers = { error: errorText(e) };
  }

  // Probe the bucket for ListObjectsV2 with one key per prefix.
  const sessions: Record<string, unknown> = {};
  let store: QStorageService | null = null;
  try {
    store = QStorageService.fromEnv(env);
  } catch (e) {
    sessions.error = errorText(e);
  }
  if (store) {
    for (const { prefix } of SESSION_PREFIXES) {
      try {
        const page = await store.list(prefix, { maxKeys: 1 });
        sessions[prefix] = { listable: true, sample: page.keys[0] ?? null, truncated: page.truncated };
      } catch (e) {
        sessions[prefix] = { listable: false, error: errorText(e) };
      }
    }
  }

  return { phase: 'status', keys: ready, completions, completionsByKid, answers, sessions };
}

// ─── answers ───────────────────────────────────────────────────────────────

interface AnswerRow {
  id: string;
  q_id: string;
  user_id: number;
  audience: string;
  answer_data: string | null;
  reasoning: string | null;
  topics: string | null;
  storage_ref: string;
}

async function migrateAnswers(env: Env, o: { dryRun: boolean; limit: number; cursor: string }): Promise<Report> {
  const report = newReport('answers', o.dryRun);
  await SecretBox.assertReady(env);

  const rows = (await env.DB.prepare(`
    SELECT id, q_id, user_id, audience, answer_data, reasoning, topics, storage_ref
    FROM Answers WHERE storage_ref IS NOT NULL AND id > ? ORDER BY id LIMIT ?
  `).bind(o.cursor, o.limit).all()).results as AnswerRow[];

  for (const row of rows) {
    report.processed++;
    const key = storageKeyOf(row.storage_ref);
    if (!key) {
      report.errors.push({ id: row.id, error: 'unreadable storage_ref' });
      continue;
    }
    try {
      const stored = await SecretStore.peek(env, key);
      if (!stored) {
        report.missing++;
        report.errors.push({ id: row.id, error: `object ${key} missing; D1 row left untouched` });
        continue;
      }
      if (stored.envelope) {
        report.alreadySealed++;
      } else {
        let payload: { value?: unknown; answer_data?: unknown; reasoning?: unknown };
        try {
          payload = JSON.parse(stored.text);
        } catch {
          report.errors.push({ id: row.id, error: `object ${key} is neither an envelope nor JSON` });
          continue;
        }
        const merged = {
          value: payload.value,
          answer_data: (payload.answer_data ?? parseAnswerData(row.answer_data)) ?? null,
          reasoning: (payload.reasoning ?? row.reasoning) ?? null,
        };
        if (!o.dryRun) {
          await SecretStore.putJSON(env, key, merged, {
            tier: row.audience,
            owner: row.user_id,
            meta: { 'q-id': row.q_id, 'user-id': String(row.user_id), 'audience': row.audience },
          });
        }
        report.sealed++;
      }
      if (rowHasD1Content(row)) {
        if (!o.dryRun) {
          await env.DB.prepare(
            'UPDATE Answers SET reasoning = NULL, topics = NULL, answer_data = ? WHERE id = ?'
          ).bind(stripAnswerDataContent(row.answer_data), row.id).run();
        }
        report.d1Cleared++;
      }
    } catch (e) {
      report.errors.push({ id: row.id, error: errorText(e) });
    }
  }

  report.nextCursor = rows.length === o.limit ? rows[rows.length - 1].id : null;
  report.done = report.nextCursor === null;
  return report;
}

// ─── completions ───────────────────────────────────────────────────────────

interface CompletionMigrateRow {
  id: string;
  user_id: number;
  visibility: string;
  answers_snapshot: string;
}

async function migrateCompletions(env: Env, o: { dryRun: boolean; limit: number; cursor: string }): Promise<Report> {
  const report = newReport('completions', o.dryRun);
  await SecretBox.assertReady(env);

  const rows = (await env.DB.prepare(`
    SELECT id, user_id, visibility, answers_snapshot
    FROM quiz_completions
    WHERE answers_snapshot IS NOT NULL AND visibility != 'public' AND id > ?
    ORDER BY id LIMIT ?
  `).bind(o.cursor, o.limit).all()).results as CompletionMigrateRow[];

  for (const row of rows) {
    report.processed++;
    try {
      JSON.parse(row.answers_snapshot);
    } catch {
      report.errors.push({ id: row.id, error: 'answers_snapshot is not JSON; left as is' });
      continue;
    }
    try {
      const sealed = await SecretStore.sealForD1(env, row.answers_snapshot, completionCtx(row.id, row.visibility, row.user_id));
      if (!o.dryRun) {
        await env.DB.prepare(
          'UPDATE quiz_completions SET answers_encrypted = ?, answers_snapshot = NULL WHERE id = ?'
        ).bind(sealed, row.id).run();
      }
      report.sealed++;
    } catch (e) {
      report.errors.push({ id: row.id, error: errorText(e) });
    }
  }

  // In a live run the WHERE clause excludes sealed rows, so the next page always starts at ''.
  // In a dry run nothing changes, so page by id.
  report.nextCursor = rows.length === o.limit ? (o.dryRun ? rows[rows.length - 1].id : '') : null;
  report.done = report.nextCursor === null;
  return report;
}

// ─── sessions ──────────────────────────────────────────────────────────────

function parseSessionCursor(cursor: string): { index: number; token?: string } {
  if (!cursor) return { index: 0 };
  const sep = cursor.indexOf(':');
  const index = Number(sep === -1 ? cursor : cursor.slice(0, sep));
  const token = sep === -1 ? '' : cursor.slice(sep + 1);
  return { index: Number.isFinite(index) ? index : 0, token: token || undefined };
}

async function listPage(env: Env, cursor: string, limit: number): Promise<{
  entry: typeof SESSION_PREFIXES[number] | null; keys: string[]; nextCursor: string | null;
}> {
  const { index, token } = parseSessionCursor(cursor);
  const entry = SESSION_PREFIXES[index];
  if (!entry) return { entry: null, keys: [], nextCursor: null };
  const store = QStorageService.fromEnv(env);
  const page = await store.list(entry.prefix, { continuationToken: token, maxKeys: limit });
  let nextCursor: string | null;
  if (page.truncated && page.nextToken) nextCursor = `${index}:${page.nextToken}`;
  else if (index + 1 < SESSION_PREFIXES.length) nextCursor = `${index + 1}:`;
  else nextCursor = null;
  return { entry, keys: page.keys, nextCursor };
}

async function migrateSessions(env: Env, o: { dryRun: boolean; limit: number; cursor: string }): Promise<Report> {
  const report = newReport('sessions', o.dryRun);
  await SecretBox.assertReady(env);

  let page: Awaited<ReturnType<typeof listPage>>;
  try {
    page = await listPage(env, o.cursor, o.limit);
  } catch (e) {
    report.note = 'list_unsupported: the bucket refused ListObjectsV2; orphan session blobs are unenumerable through the API. Live sessions are re-sealed lazily on read (spec §7.9).';
    report.errors.push({ id: 'list', error: errorText(e) });
    report.done = true;
    return report;
  }
  if (!page.entry) {
    report.done = true;
    return report;
  }
  const { entry } = page;
  const kv = env[entry.kv] as KVNamespace | undefined;
  if (!kv) {
    report.errors.push({ id: entry.kv, error: 'KV namespace not bound' });
    report.done = true;
    return report;
  }

  for (const key of page.keys) {
    report.processed++;
    const sid = key.slice(entry.prefix.length);
    if (!sid || sid.includes('/')) continue;
    try {
      const raw = await kv.get(`session:${sid}`);
      if (!raw) {
        if (!o.dryRun) await SecretStore.deleteObject(env, key);
        report.orphansDeleted++;
        continue;
      }
      const fid = (JSON.parse(raw) as { fid?: number }).fid;
      if (typeof fid !== 'number') {
        report.errors.push({ id: key, error: 'KV session has no fid; left as is' });
        continue;
      }
      const stored = await SecretStore.peek(env, key);
      if (!stored) {
        report.missing++;
        continue;
      }
      if (stored.envelope) {
        report.alreadySealed++;
        continue;
      }
      let answers: unknown;
      try {
        answers = JSON.parse(stored.text);
      } catch {
        report.errors.push({ id: key, error: 'object is neither an envelope nor JSON' });
        continue;
      }
      if (!o.dryRun) {
        await SecretStore.putJSON(env, key, answers, {
          tier: 'session',
          owner: fid,
          meta: { 'session-id': sid, 'fid': String(fid) },
        });
      }
      report.sealed++;
    } catch (e) {
      report.errors.push({ id: key, error: errorText(e) });
    }
  }

  report.nextCursor = page.nextCursor;
  report.done = report.nextCursor === null;
  return report;
}

// ─── rewrap ────────────────────────────────────────────────────────────────

async function rewrap(env: Env, o: { dryRun: boolean; limit: number; cursor: string; target: RewrapTarget }): Promise<Report> {
  const report = newReport('rewrap', o.dryRun);
  report.note = `target=${o.target}`;
  const current = await SecretBox.currentKid(env);

  if (o.target === 'completions') {
    // v1 envelopes carry `local:<name>`; anything not equal to the current kid is rewrapped.
    const rows = (await env.DB.prepare(`
      SELECT id, answers_encrypted FROM quiz_completions
      WHERE answers_encrypted IS NOT NULL AND json_extract(answers_encrypted, '$.kid') != ? AND id > ?
      ORDER BY id LIMIT ?
    `).bind(current, o.cursor, o.limit).all()).results as Array<{ id: string; answers_encrypted: string }>;
    for (const row of rows) {
      report.processed++;
      try {
        const r = await SecretStore.rewrapText(env, row.answers_encrypted);
        if (!r) {
          report.errors.push({ id: row.id, error: 'answers_encrypted is not an envelope' });
          continue;
        }
        if (r.changed) {
          if (!o.dryRun) {
            await env.DB.prepare('UPDATE quiz_completions SET answers_encrypted = ? WHERE id = ?').bind(r.text, row.id).run();
          }
          report.rewrapped++;
        }
      } catch (e) {
        report.errors.push({ id: row.id, error: errorText(e) });
      }
    }
    report.nextCursor = rows.length === o.limit ? (o.dryRun ? rows[rows.length - 1].id : '') : null;
    report.done = report.nextCursor === null;
    return report;
  }

  if (o.target === 'answers') {
    const rows = (await env.DB.prepare(`
      SELECT id, storage_ref FROM Answers WHERE storage_ref IS NOT NULL AND id > ? ORDER BY id LIMIT ?
    `).bind(o.cursor, o.limit).all()).results as Array<{ id: string; storage_ref: string }>;
    for (const row of rows) {
      report.processed++;
      const key = storageKeyOf(row.storage_ref);
      if (!key) continue;
      try {
        const stored = await SecretStore.peek(env, key);
        if (!stored) { report.missing++; continue; }
        if (!stored.envelope) { report.errors.push({ id: row.id, error: 'legacy plaintext; run phase "answers" first' }); continue; }
        if (SecretBox.kidOf(stored.envelope) === current) { report.alreadySealed++; continue; }
        const next = await SecretBox.rewrap(env, stored.envelope);
        if (!o.dryRun) await SecretStore.putEnvelope(env, key, next);
        report.rewrapped++;
      } catch (e) {
        report.errors.push({ id: row.id, error: errorText(e) });
      }
    }
    report.nextCursor = rows.length === o.limit ? rows[rows.length - 1].id : null;
    report.done = report.nextCursor === null;
    return report;
  }

  // sessions
  let page: Awaited<ReturnType<typeof listPage>>;
  try {
    page = await listPage(env, o.cursor, o.limit);
  } catch (e) {
    report.note = 'list_unsupported: session blobs cannot be enumerated; they are rewrapped lazily when read under the new key is not possible — keep the old key in ANSWER_KEKS until the sessions expire (30 days).';
    report.errors.push({ id: 'list', error: errorText(e) });
    report.done = true;
    return report;
  }
  if (!page.entry) { report.done = true; return report; }
  for (const key of page.keys) {
    report.processed++;
    try {
      const stored = await SecretStore.peek(env, key);
      if (!stored) { report.missing++; continue; }
      if (!stored.envelope) { report.errors.push({ id: key, error: 'legacy plaintext; run phase "sessions" first' }); continue; }
      if (SecretBox.kidOf(stored.envelope) === current) { report.alreadySealed++; continue; }
      const next = await SecretBox.rewrap(env, stored.envelope);
      if (!o.dryRun) await SecretStore.putEnvelope(env, key, next);
      report.rewrapped++;
    } catch (e) {
      report.errors.push({ id: key, error: errorText(e) });
    }
  }
  report.nextCursor = page.nextCursor;
  report.done = report.nextCursor === null;
  return report;
}

