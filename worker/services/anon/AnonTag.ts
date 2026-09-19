/**
 * AnonTag — the anon tier's "sealed to Q" primitives.
 *
 * An Anon row never carries its author: `Answers.user_id` and
 * `answer_meta.responder_fid` hold the anon placeholder (the @4n0n FID), and
 * the only link to a person is the `anon_attributions` row, which stores
 *
 *   author_tag = HMAC-SHA256(ANON_TAG_KEY, "<fid>|<scope>")   (hex)
 *   author_ct  = SecretBox envelope of the FID                (operator path)
 *
 * `scope` is the question id, so a person's tags on two questions are
 * unrelated: a database dump can neither attribute an anon row nor cluster
 * one person's anon rows. The Worker, holding `ANON_TAG_KEY` and the KEK,
 * still can — the guarantee is "sealed to Q", the same as the Secret tier,
 * and SECURITY.md says so.
 *
 * Every per-person query over `Answers` that may meet an Anon row goes through
 * `personKeySql` (tallies, dedup, churn) or `ownRowsSql` (sticky audience,
 * "my row on this question"), never through `user_id` alone.
 */

export class AnonTagNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnonTagNotReadyError';
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

/** The pre-2026 anon placeholder (`src/lib/consts.ts` anon_id); rows written with it stay recognisable. */
export const LEGACY_ANON_USER_ID = 3;

/** The FID an Anon row carries in `user_id` / `responder_fid`: the @4n0n account. */
export function anonPlaceholderFid(env: Env): number {
  return Number(env?.ANON_FID) || 514282;
}

/** Every id that means "no author on this row". */
export function anonPlaceholderIds(env: Env): number[] {
  return [anonPlaceholderFid(env), LEGACY_ANON_USER_ID];
}

export function isAnonPlaceholder(env: Env, id: unknown): boolean {
  const n = Number(id);
  return n === anonPlaceholderFid(env) || n === LEGACY_ANON_USER_ID;
}

const keys = new Map<string, Promise<CryptoKey>>();

function b64decode(text: string): Uint8Array {
  const bin = atob(text.trim());
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function tagKey(env: Env): Promise<CryptoKey> {
  const raw = typeof env?.ANON_TAG_KEY === 'string' ? env.ANON_TAG_KEY.trim() : '';
  if (!raw) throw new AnonTagNotReadyError('ANON_TAG_KEY is not configured');
  const cached = keys.get(raw);
  if (cached) return cached;
  let bytes: Uint8Array;
  try {
    bytes = b64decode(raw);
  } catch {
    throw new AnonTagNotReadyError('ANON_TAG_KEY is not valid base64');
  }
  if (bytes.byteLength < 32) throw new AnonTagNotReadyError(`ANON_TAG_KEY is ${bytes.byteLength} bytes, want 32`);
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const p = crypto.subtle.importKey('raw', buf, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  keys.set(raw, p);
  p.catch(() => keys.delete(raw)); // never cache a failure
  return p;
}

/** True when the tag key is configured and well-formed. */
export async function anonTagReady(env: Env): Promise<boolean> {
  try {
    await tagKey(env);
    return true;
  } catch {
    return false;
  }
}

/**
 * The lookup tag for one person on one scope (a question id, or for an anon
 * question the question's own id). Deterministic, so the Worker can find the
 * person's row; keyed and per-scope, so nothing else can.
 */
export async function anonTag(env: Env, fid: number, scopeId: string): Promise<string> {
  const key = await tagKey(env);
  const msg = new TextEncoder().encode(`${Number(fid)}|${scopeId}`);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  let hex = '';
  for (const b of sig) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/** AAD for the sealed FID on an attribution row. */
export function attributionCtx(publicId: string): string {
  return `anon_attributions:${publicId}|anon|0`;
}

/**
 * SQL expression naming the person behind a row of `Answers` (aliased
 * `alias`): the attribution tag for an Anon row, `u:<fid>` otherwise. Rows
 * written before the sweep (tag NULL, author_id set) resolve through the
 * legacy column so tallies stay right during the migration window.
 */
export function personKeySql(alias = 'a'): string {
  return `COALESCE(` +
    `(SELECT COALESCE(t.author_tag, 'legacy:' || t.author_id) FROM anon_attributions t ` +
    `WHERE t.public_id = ${alias}.id AND t.type = 'answer'), ` +
    `'u:' || ${alias}.user_id)`;
}

/**
 * WHERE fragment matching one person's rows on a question: their named rows,
 * plus any Anon row whose attribution carries their tag. Binds, in order:
 * `fid`, `tag` (`anonTag(env, fid, questionId)`; pass '' when no tag key —
 * an Anon row then never matches).
 */
export function ownRowsSql(alias = 'a'): string {
  return `(${alias}.user_id = ? OR ${alias}.id IN ` +
    `(SELECT public_id FROM anon_attributions WHERE type = 'answer' AND author_tag = ?))`;
}
