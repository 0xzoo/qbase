/**
 * The owner's record, loaded for the personal MCP tools (context.ts shapes it).
 *
 * Same sources as the owner-only routes (`listMyAnswers`, `/answers/mine`,
 * `listMyQuizAnswers`): named rows by person key, Anon rows through the
 * sealed author tags, Secret rows opened with `openSealedAnswer`. Two cuts:
 *
 *  - Anon linkage is only unsealed when the grant's ceiling reaches Anon. A
 *    Public-ceiling read never runs the tag lookup.
 *  - Sealed values are opened only for the questions a tool will return
 *    (`openSealed(record, qIds)`): get_context selects on stems first, so a
 *    call opens, decrypts and logs only what it serves.
 *
 * Scale assumption: the whole record is loaded per tool call and fits in
 * memory (Zoo's, the largest today: ~90 answers, ~30 authored). Two parts
 * grow with the whole site rather than the owner: the anon path lists every
 * question with any Anon answer before resolving the owner's tags. Revisit
 * when a record passes ~2,000 answers or the anon scan shows in latency:
 * page the named rows and keep a per-owner index of anon answer ids.
 */

import { ownAnonAnswerIds } from '../AnonAttributionService';
import { openSealedAnswer } from '../../handlers/answers/shared';
import { TIER_RANK, type Grant, type OwnerRecord, type RecordAnswer, type ScaleConfig } from './context';
import type { QuestionTaxonomy } from '../taxonomy/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;
type Row = Record<string, unknown>;

const IN_CHUNK = 90;
const OPEN_CONCURRENCY = 8;
const COLS = `a.id, a.q_id, a.user_id, a.value, a.reasoning, a.audience, a.created_at, a.poll_id, a.storage_ref, a.quiz_completion_id,
              q.stem, q.type, q.taxonomy, q.a_options, q.scale_config`;

const parse = <T>(s: unknown): T | null => {
  if (typeof s !== 'string' || !s) return null;
  try { return JSON.parse(s) as T; } catch { return null; }
};

/** A loaded row keeps what it needs to be opened later. */
export interface LoadedAnswer extends RecordAnswer {
  storage_ref: string | null;
  user_id: number;
  /** True once a sealed row has been opened (or never needed opening). */
  opened: boolean;
}

export interface LoadedRecord extends OwnerRecord {
  answers: LoadedAnswer[];
}

function isSealed(audience: unknown): boolean {
  return audience === 'Private' || audience === 'Allowlist';
}

function toAnswer(r: Row): LoadedAnswer {
  const choice = r.type === 'mc' || r.type === 'checkbox';
  const sealed = isSealed(r.audience);
  return {
    id: String(r.id), q_id: String(r.q_id), stem: String(r.stem ?? ''), question_type: (r.type as string) ?? null,
    options: choice ? parse<string[]>(r.a_options) : null,
    scale_config: parse<ScaleConfig>(r.scale_config),
    value: sealed ? null : r.value,
    reasoning: sealed ? null : ((r.reasoning as string) || null),
    audience: String(r.audience), created_at: String(r.created_at), poll_id: (r.poll_id as string) ?? null,
    source: r.quiz_completion_id ? 'quiz' : 'feed',
    taxonomy: parse<Partial<QuestionTaxonomy>>(r.taxonomy),
    storage_ref: (r.storage_ref as string) ?? null, user_id: Number(r.user_id), opened: !sealed,
  };
}

export async function loadOwnerRecord(env: Env, ownerKey: number, grant: Grant): Promise<LoadedRecord> {
  const rows: Row[] = [];
  // Named rows within the ceiling. Allowlist is sealed like Private; both count as Secret.
  const audiences = ['Public', ...(TIER_RANK[grant.ceiling] >= TIER_RANK.Secret ? ['Private', 'Allowlist'] : [])];
  const named = await env.DB.prepare(
    `SELECT ${COLS} FROM Answers a JOIN queries q ON q.id = a.q_id
      WHERE a.user_id = ? AND a.audience IN (${audiences.map(() => '?').join(',')})`,
  ).bind(ownerKey, ...audiences).all();
  rows.push(...((named.results ?? []) as Row[]));

  if (TIER_RANK[grant.ceiling] >= TIER_RANK.Anon) {
    const anonQs = await env.DB.prepare("SELECT DISTINCT q_id FROM Answers WHERE audience = 'Anon'").all();
    let ids: string[] = [];
    try {
      ids = [...await ownAnonAnswerIds(env, ownerKey, ((anonQs.results ?? []) as Row[]).map((r) => String(r.q_id)))];
    } catch (e) {
      console.warn('[personal] anon lookup unavailable:', e instanceof Error ? e.message : e);
    }
    for (let i = 0; i < ids.length; i += IN_CHUNK) {
      const chunk = ids.slice(i, i + IN_CHUNK);
      const r = await env.DB.prepare(
        `SELECT ${COLS} FROM Answers a JOIN queries q ON q.id = a.q_id WHERE a.id IN (${chunk.map(() => '?').join(',')})`,
      ).bind(...chunk).all();
      rows.push(...((r.results ?? []) as Row[]));
    }
  }

  // Questions the owner asked under their own name (anon-authored ones carry the bot's id).
  const authored = await env.DB.prepare(
    'SELECT id, stem, created_at, taxonomy FROM queries WHERE coiner_id = ?1 OR owner_id = ?1',
  ).bind(ownerKey).all();

  // Latest completion per quiz: the measured profile.
  const completions = await env.DB.prepare(
    'SELECT quiz_id, completed_at, result_category, scores, visibility FROM quiz_completions WHERE user_id = ? ORDER BY completed_at DESC',
  ).bind(ownerKey).all();
  const latest = new Map<string, Row>();
  for (const c of (completions.results ?? []) as Row[]) if (!latest.has(String(c.quiz_id))) latest.set(String(c.quiz_id), c);

  return {
    answers: rows.map(toAnswer),
    authored: ((authored.results ?? []) as Row[]).map((r) => ({
      id: String(r.id), stem: String(r.stem ?? ''), created_at: String(r.created_at ?? ''), taxonomy: parse(r.taxonomy),
    })),
    measured: [...latest.values()].map((c) => ({
      quiz_id: String(c.quiz_id), completed_at: new Date(Number(c.completed_at)).toISOString(),
      result: (c.result_category as string) ?? null, scores: parse(c.scores), visibility: String(c.visibility ?? 'private'),
    })),
  };
}

/**
 * Open the sealed rows on the given questions in place (value + reasoning).
 * A row that can't be opened keeps value null and is left out of the read log.
 */
export async function openSealed(env: Env, record: LoadedRecord, qIds: Iterable<string>): Promise<void> {
  const want = new Set(qIds);
  const todo = record.answers.filter((a) => !a.opened && want.has(a.q_id));
  for (let i = 0; i < todo.length; i += OPEN_CONCURRENCY) {
    await Promise.all(todo.slice(i, i + OPEN_CONCURRENCY).map(async (a) => {
      try {
        const payload = await openSealedAnswer(env, { storage_ref: a.storage_ref, audience: a.audience, user_id: a.user_id });
        if (payload && payload.value !== undefined) {
          a.value = payload.value;
          a.reasoning = payload.reasoning ?? null;
          a.opened = true;
        }
      } catch (e) {
        console.warn(`[personal] could not open ${a.id}:`, e instanceof Error ? e.message : e);
      }
    }));
  }
}
