/**
 * AnonAttributionService — the single link between an anon row and a person.
 *
 * Since 2026-09-19 (card t_9f2869db) the link is sealed to Q: a keyed,
 * per-question tag for lookups and the FID in a SecretBox envelope for the
 * operator path. `author_id` is NULL on every row the sweep has touched; the
 * column stays until a later migration drops it, and reads tolerate a legacy
 * row (author_id set, tag NULL) so the code can ship before the sweep runs.
 *
 * Callers never see a FID come out of this module on a user-facing path:
 * ownership is answered as a boolean (`isAuthor`) or as the set of the
 * requester's own anon answer ids on the questions at hand
 * (`ownAnonAnswerIds`). `openAuthorFid` is the operator path (moderation,
 * tag-key rotation) and is not called by any route.
 */

import { SecretBox } from './secret/SecretBox';
import { anonPlaceholderFid, anonTag, attributionCtx } from './anon/AnonTag';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type D1PreparedStatement = any;

export type AttributionType = 'question' | 'answer' | 'direct_query';

export interface AttributionParams {
  /** answer id, or the question id for an anon question */
  public_id: string;
  fid: number;
  type: AttributionType;
  /** the question id the tag is scoped to (for a question, its own id) */
  scope_id: string;
  created_at?: string;
}

/** D1 keeps bind parameters under 100 per statement. */
const IN_CHUNK = 80;

/**
 * The statement that records (or refreshes) an attribution. Built ahead of
 * time so a writer can put it in the same D1 batch as the row it attributes:
 * an anon row without its attribution is unowned, so the two land together.
 */
export async function attributionStatement(env: Env, p: AttributionParams): Promise<D1PreparedStatement> {
  const tag = await anonTag(env, p.fid, p.scope_id);
  const ct = await SecretBox.sealText(env, String(Number(p.fid)), attributionCtx(p.public_id));
  return env.DB.prepare(
    `INSERT INTO anon_attributions (id, public_id, author_id, author_tag, author_ct, type, created_at)
     VALUES (?, ?, NULL, ?, ?, ?, ?)
     ON CONFLICT(public_id) DO UPDATE SET
       author_id = NULL, author_tag = excluded.author_tag, author_ct = excluded.author_ct, type = excluded.type`,
  ).bind(crypto.randomUUID(), p.public_id, tag, ct, p.type, p.created_at ?? new Date().toISOString());
}

export function deleteAttributionStatement(env: Env, publicId: string, type: AttributionType = 'answer'): D1PreparedStatement {
  return env.DB.prepare('DELETE FROM anon_attributions WHERE public_id = ? AND type = ?').bind(publicId, type);
}

/** Record an attribution on its own (anon questions). Throws when the tag key or KEK is missing. */
export async function createAttribution(env: Env, p: AttributionParams): Promise<{ success: boolean }> {
  await (await attributionStatement(env, p)).run();
  return { success: true };
}

/** Is `fid` the author of the anon content `publicId`? A legacy row compares `author_id`. */
export async function isAuthor(env: Env, publicId: string, fid: number, scopeId: string, type?: AttributionType): Promise<boolean> {
  const row = await env.DB.prepare(
    'SELECT author_id, author_tag, type FROM anon_attributions WHERE public_id = ?',
  ).bind(publicId).first() as { author_id: number | null; author_tag: string | null; type: string } | null;
  if (!row) return false;
  if (type && row.type !== type) return false;
  if (row.author_tag) return row.author_tag === await anonTag(env, fid, scopeId);
  return row.author_id !== null && Number(row.author_id) === Number(fid);
}

/**
 * The requester's own anon answer ids among the questions given. One HMAC per
 * question, one query per 80 questions; legacy rows match on `author_id`.
 */
export async function ownAnonAnswerIds(env: Env, fid: number, qIds: Iterable<string>): Promise<Set<string>> {
  const unique = [...new Set([...qIds].filter((q): q is string => typeof q === 'string' && q !== ''))];
  const out = new Set<string>();
  if (!Number.isFinite(Number(fid))) return out;
  const tags = await Promise.all(unique.map((q) => anonTag(env, fid, q)));
  for (let i = 0; i < tags.length || i === 0; i += IN_CHUNK) {
    const chunk = tags.slice(i, i + IN_CHUNK);
    const inList = chunk.length ? `author_tag IN (${chunk.map(() => '?').join(',')}) OR ` : '';
    const { results } = await env.DB.prepare(
      `SELECT public_id FROM anon_attributions WHERE type = 'answer' AND (${inList}author_id = ?)`,
    ).bind(...chunk, Number(fid)).all();
    for (const r of (results ?? []) as Array<{ public_id: string }>) out.add(r.public_id);
    if (!chunk.length) break;
  }
  return out;
}

/** Operator path: the FID sealed on an attribution row, or the legacy plaintext one. */
export async function openAuthorFid(env: Env, publicId: string): Promise<number | null> {
  const row = await env.DB.prepare(
    'SELECT author_id, author_ct FROM anon_attributions WHERE public_id = ?',
  ).bind(publicId).first() as { author_id: number | null; author_ct: string | null } | null;
  if (!row) return null;
  if (row.author_ct) {
    const n = Number(await SecretBox.openText(env, row.author_ct, attributionCtx(publicId)));
    return Number.isFinite(n) ? n : null;
  }
  return row.author_id === null ? null : Number(row.author_id);
}

export interface AnonWrite {
  /** what `Answers.user_id` / `answer_meta.responder_fid` carry */
  rowFid: number;
  /** the attribution to batch with the row; null for a named row */
  statement: D1PreparedStatement | null;
}

/**
 * What a writer stores for a new row: the person's FID on a named row, the
 * placeholder plus an attribution statement on an Anon one.
 */
export async function anonWriteFor(
  env: Env,
  p: { fid: number; audience: string; answerId: string; qId: string; createdAt?: string },
): Promise<AnonWrite> {
  if (p.audience !== 'Anon') return { rowFid: p.fid, statement: null };
  return {
    rowFid: anonPlaceholderFid(env),
    statement: await attributionStatement(env, { public_id: p.answerId, fid: p.fid, type: 'answer', scope_id: p.qId, created_at: p.createdAt }),
  };
}

export const AnonAttributionService = {
  attributionStatement,
  deleteAttributionStatement,
  createAttribution,
  isAuthor,
  ownAnonAnswerIds,
  openAuthorFid,
  anonWriteFor,
};
