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
import { isAccountId } from './accounts/AccountService';

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

// ── Dual tags across the account cutover (docs/specs/account-root.md §5) ─────
// Between the `rewrite` phase and the `retag` sweep, callers pass account ids
// while attribution tags are still HMAC over the legacy key (the fid). An
// account id's legacy_key is fixed once set, so a found value is cached for
// the isolate's life. Remove with the fallbacks once `status` reports 0
// legacy anon tags.

const legacyKeys = new Map<number, number>();

/** The legacy key (pre-cutover person key) of an account id; null for a non-account key or none. */
export async function legacyKeyOf(env: Env, key: number): Promise<number | null> {
  const n = Number(key);
  if (!isAccountId(n)) return null;
  const cached = legacyKeys.get(n);
  if (cached !== undefined) return cached;
  try {
    const row = await env.DB.prepare('SELECT legacy_key FROM accounts WHERE id = ?').bind(n).first() as { legacy_key: number | null } | null;
    if (row?.legacy_key === null || row?.legacy_key === undefined) return null;
    const legacy = Number(row.legacy_key);
    legacyKeys.set(n, legacy);
    return legacy;
  } catch {
    return null; // no accounts table: nothing was rewritten, there is no legacy key
  }
}

/** Every key a person's attributions may be tagged over: the key itself, then its legacy key if any. */
async function ownerKeys(env: Env, key: number): Promise<number[]> {
  const legacy = await legacyKeyOf(env, key);
  return legacy === null || legacy === Number(key) ? [Number(key)] : [Number(key), legacy];
}

/**
 * The tags that identify `key` as the author on `scope`: the tag over the key,
 * plus (during the cutover window) the tag over the account's legacy key.
 * Throws AnonTagNotReadyError without a tag key, like `anonTag`.
 */
export async function authorTags(env: Env, key: number, scope: string): Promise<string[]> {
  return Promise.all((await ownerKeys(env, key)).map((k) => anonTag(env, k, scope)));
}

/**
 * `ownRowsSql` with the anon branch over two tags: `author_tag IN (?, ?)`.
 * Binds, in order: the person key, then two tags — use `ownRowsBinds`.
 */
export function ownRowsDualSql(alias = 'a'): string {
  return `(${alias}.user_id = ? OR ${alias}.id IN ` +
    `(SELECT public_id FROM anon_attributions WHERE type = 'answer' AND author_tag IN (?, ?)))`;
}

/**
 * The binds for `ownRowsDualSql`: key, tag, tag. Accepts one tag (repeated),
 * the list from `authorTags` (first two), or null/empty ('' — an Anon row
 * then never matches).
 */
export function ownRowsBinds(key: number, tags: string | readonly string[] | null | undefined): [number, string, string] {
  const list = typeof tags === 'string' ? [tags] : (tags ?? []);
  const first = list[0] ?? '';
  return [key, first, list[1] ?? first];
}

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

/**
 * Is the person `fid` (a person key: fid before the cutover, account id after)
 * the author of the anon content `publicId`? Accepts a tag over the account's
 * legacy key until the retag sweep. A legacy row compares `author_id`.
 */
export async function isAuthor(env: Env, publicId: string, fid: number, scopeId: string, type?: AttributionType): Promise<boolean> {
  const row = await env.DB.prepare(
    'SELECT author_id, author_tag, type FROM anon_attributions WHERE public_id = ?',
  ).bind(publicId).first() as { author_id: number | null; author_tag: string | null; type: string } | null;
  if (!row) return false;
  if (type && row.type !== type) return false;
  if (row.author_tag) return (await authorTags(env, fid, scopeId)).includes(row.author_tag);
  if (row.author_id === null) return false;
  return (await ownerKeys(env, fid)).includes(Number(row.author_id));
}

/**
 * The requester's own anon answer ids among the questions given. One HMAC per
 * question and owner key (two during the cutover window), one query per 80
 * tags; legacy rows match on `author_id`.
 */
export async function ownAnonAnswerIds(env: Env, fid: number, qIds: Iterable<string>): Promise<Set<string>> {
  const unique = [...new Set([...qIds].filter((q): q is string => typeof q === 'string' && q !== ''))];
  const out = new Set<string>();
  if (!Number.isFinite(Number(fid))) return out;
  const keys = await ownerKeys(env, fid);
  const tags = await Promise.all(unique.flatMap((q) => keys.map((k) => anonTag(env, k, q))));
  const idList = `author_id IN (${keys.map(() => '?').join(',')})`;
  for (let i = 0; i < tags.length || i === 0; i += IN_CHUNK) {
    const chunk = tags.slice(i, i + IN_CHUNK);
    const inList = chunk.length ? `author_tag IN (${chunk.map(() => '?').join(',')}) OR ` : '';
    const { results } = await env.DB.prepare(
      `SELECT public_id FROM anon_attributions WHERE type = 'answer' AND (${inList}${idList})`,
    ).bind(...chunk, ...keys).all();
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
  /**
   * what `Answers.user_id` carries: the person key on a named row, the anon
   * placeholder on an Anon one (and then also `answer_meta.responder_fid`).
   */
  rowFid: number;
  /** the attribution to batch with the row; null for a named row */
  statement: D1PreparedStatement | null;
}

/**
 * What a writer stores for a new row: the person key on a named row, the
 * placeholder plus an attribution statement (tagged over the person key) on
 * an Anon one. `fid` is the person key (account id after the cutover).
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
  authorTags,
  legacyKeyOf,
};
