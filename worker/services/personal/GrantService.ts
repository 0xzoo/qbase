/**
 * Grants to consumers (docs/specs/consent-model.md §4) — for now, the owner's
 * own agents: a personal MCP key is a grant with consumer_kind = 'key'
 * (personal-mcp.md §3.1). Migration 0079.
 *
 * The key is `qb_` + 32 random bytes (base64url). Only its sha-256 is stored;
 * the secret is returned once, at creation. A key resolves to its grant, and
 * the grant to the owner's person key, so the tools read "my rows" exactly the
 * way the owner-only routes do, cut to the grant's ceiling, disclosure and
 * domains. Every read is logged (`logRead`) and listed at /me/access.
 */

import type { Grant, Tier } from './context';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

export const KEY_PREFIX = 'qb_';
/** The copy shown at key creation (consent_copy). v2 names qbase's own model provider as a reader (migration 0080). */
export const KEY_COPY_ID = 'mcp-key-v2';
export const TIERS: Tier[] = ['Public', 'Anon', 'Secret'];
export const MAX_GRANTS_PER_OWNER = 20;
/** `last_used_at` is refreshed at most this often, so a busy agent isn't a write per call. */
const TOUCH_MS = 60_000;

export interface GrantRow {
  id: string;
  owner_key: number;
  consumer_kind: string;
  consumer_id: string | null;
  label: string | null;
  key_hint: string | null;
  domains: string;
  disclosure: 'derived' | 'raw';
  ceiling: Tier;
  purpose: string | null;
  expires_at: number | null;
  revoked_at: number | null;
  copy_id: string | null;
  created_at: number;
  last_used_at: number | null;
}

export interface KeyGrantInput {
  label?: string;
  ceiling?: Tier;
  disclosure?: 'derived' | 'raw';
  domains?: '*' | string[];
  purpose?: string;
  expires_at?: number | null;
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Plain sha-256, on purpose: the key is 32 random bytes, so there's no
 * dictionary to slow down, and this runs on every /mcp request. A slow KDF
 * here would cost latency and buy nothing.
 */
export async function hashKey(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function isAgentKey(token: string | null | undefined): token is string {
  return typeof token === 'string' && token.startsWith(KEY_PREFIX) && token.length > KEY_PREFIX.length + 20;
}

/** The grant as context.ts reads it. */
export function toGrant(row: GrantRow): Grant {
  let domains: Grant['domains'] = '*';
  if (row.domains && row.domains !== '*') {
    try {
      const parsed = JSON.parse(row.domains);
      if (Array.isArray(parsed)) domains = parsed.filter((d): d is string => typeof d === 'string');
    } catch { /* malformed → no domains, fail closed */ domains = []; }
  }
  return { id: row.id, disclosure: row.disclosure === 'raw' ? 'raw' : 'derived', ceiling: TIERS.includes(row.ceiling) ? row.ceiling : 'Public', domains };
}

export class GrantError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function validate(input: KeyGrantInput): Required<Omit<KeyGrantInput, 'expires_at' | 'purpose' | 'label'>> & KeyGrantInput {
  const ceiling = input.ceiling ?? 'Public';
  if (!TIERS.includes(ceiling)) throw new GrantError('bad_ceiling', `ceiling must be one of ${TIERS.join(', ')}`);
  const disclosure = input.disclosure ?? 'raw';
  if (disclosure !== 'raw' && disclosure !== 'derived') throw new GrantError('bad_disclosure', "disclosure must be 'raw' or 'derived'");
  const domains = input.domains ?? '*';
  if (domains !== '*' && (!Array.isArray(domains) || domains.length === 0 || domains.some((d) => typeof d !== 'string' || !d.trim()))) {
    throw new GrantError('bad_domains', "domains must be '*' or a non-empty list of topics");
  }
  if (input.label !== undefined && (typeof input.label !== 'string' || input.label.length > 80)) throw new GrantError('bad_label', 'label: up to 80 characters');
  if (input.purpose !== undefined && (typeof input.purpose !== 'string' || input.purpose.length > 200)) throw new GrantError('bad_purpose', 'purpose: up to 200 characters');
  if (input.expires_at != null && (!Number.isFinite(input.expires_at) || input.expires_at <= Date.now())) {
    throw new GrantError('bad_expiry', 'expires_at must be a future time in ms');
  }
  return { ...input, ceiling, disclosure, domains };
}

/** Create a key grant for the owner. Returns the secret once; it is never stored. */
export async function createKeyGrant(env: Env, ownerKey: number, input: KeyGrantInput): Promise<{ grant: GrantRow; secret: string }> {
  const v = validate(input);
  const live = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM grants WHERE owner_key = ? AND revoked_at IS NULL',
  ).bind(ownerKey).first() as { n: number } | null;
  if ((live?.n ?? 0) >= MAX_GRANTS_PER_OWNER) throw new GrantError('too_many', `at most ${MAX_GRANTS_PER_OWNER} live grants; revoke one first`);

  const secret = KEY_PREFIX + base64url(crypto.getRandomValues(new Uint8Array(32)));
  const id = crypto.randomUUID();
  const now = Date.now();
  const row: GrantRow = {
    id, owner_key: ownerKey, consumer_kind: 'key', consumer_id: null,
    label: v.label?.trim() || null, key_hint: secret.slice(-4),
    domains: v.domains === '*' ? '*' : JSON.stringify(v.domains.map((d) => d.trim())),
    disclosure: v.disclosure, ceiling: v.ceiling, purpose: v.purpose?.trim() || null,
    expires_at: v.expires_at ?? null, revoked_at: null, copy_id: KEY_COPY_ID, created_at: now, last_used_at: null,
  };
  await env.DB.prepare(
    `INSERT INTO grants (id, owner_key, consumer_kind, consumer_id, label, key_hash, key_hint, domains, disclosure, ceiling, purpose, expires_at, copy_id, created_at)
     VALUES (?, ?, 'key', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, ownerKey, row.label, await hashKey(secret), row.key_hint, row.domains, row.disclosure, row.ceiling, row.purpose, row.expires_at, row.copy_id, now).run();
  return { grant: row, secret };
}

const COLS = 'id, owner_key, consumer_kind, consumer_id, label, key_hint, domains, disclosure, ceiling, purpose, expires_at, revoked_at, copy_id, created_at, last_used_at';

/** A bearer key → its live grant, or null (unknown, revoked, expired). */
export async function resolveKey(env: Env, secret: string): Promise<GrantRow | null> {
  if (!isAgentKey(secret)) return null;
  const row = await env.DB.prepare(`SELECT ${COLS} FROM grants WHERE key_hash = ? AND consumer_kind = 'key'`)
    .bind(await hashKey(secret)).first() as GrantRow | null;
  if (!row || row.revoked_at !== null) return null;
  const now = Date.now();
  if (row.expires_at !== null && row.expires_at <= now) return null;
  if (row.last_used_at === null || now - row.last_used_at > TOUCH_MS) {
    try {
      await env.DB.prepare('UPDATE grants SET last_used_at = ? WHERE id = ?').bind(now, row.id).run();
    } catch (e) {
      console.warn('[grants] touch failed:', e instanceof Error ? e.message : e);
    }
  }
  return row;
}

/** `Authorization: Bearer qb_…` → the grant, or null. */
export async function requireAgentKey(request: Request, env: Env): Promise<GrantRow | null> {
  const h = request.headers.get('Authorization');
  if (!h?.startsWith('Bearer ')) return null;
  return resolveKey(env, h.slice(7).trim());
}

/** Highest tier among served answers. */
export function maxTier(audiences: Iterable<string>): Tier | null {
  let best: Tier | null = null;
  for (const a of audiences) {
    const t: Tier = a === 'Public' ? 'Public' : a === 'Anon' ? 'Anon' : 'Secret';
    if (best === null || TIERS.indexOf(t) > TIERS.indexOf(best)) best = t;
  }
  return best;
}

/**
 * Log one read. Called after the response body is built, with the audiences of
 * the answers whose content it carries. A failure to log fails the read: an
 * unlogged read is the thing the log exists to rule out.
 */
export async function logRead(env: Env, grantId: string, tool: string, audiences: string[]): Promise<void> {
  await env.DB.prepare('INSERT INTO grant_reads (grant_id, tool, answer_count, max_tier, at) VALUES (?, ?, ?, ?, ?)')
    .bind(grantId, tool, audiences.length, maxTier(audiences), Date.now()).run();
}

export interface GrantSummary extends GrantRow {
  reads: { total: number; answers: number; last_at: number | null };
  recent: Array<{ tool: string; answer_count: number; max_tier: string | null; at: number }>;
}

export async function listGrants(env: Env, ownerKey: number): Promise<GrantSummary[]> {
  const rows = ((await env.DB.prepare(`SELECT ${COLS} FROM grants WHERE owner_key = ? ORDER BY created_at DESC`)
    .bind(ownerKey).all()).results ?? []) as GrantRow[];
  const out: GrantSummary[] = [];
  for (const g of rows) {
    const agg = await env.DB.prepare(
      'SELECT COUNT(*) AS total, COALESCE(SUM(answer_count), 0) AS answers, MAX(at) AS last_at FROM grant_reads WHERE grant_id = ?',
    ).bind(g.id).first() as { total: number; answers: number; last_at: number | null } | null;
    const recent = ((await env.DB.prepare(
      'SELECT tool, answer_count, max_tier, at FROM grant_reads WHERE grant_id = ? ORDER BY at DESC, id DESC LIMIT 20',
    ).bind(g.id).all()).results ?? []) as GrantSummary['recent'];
    out.push({ ...g, reads: { total: agg?.total ?? 0, answers: agg?.answers ?? 0, last_at: agg?.last_at ?? null }, recent });
  }
  return out;
}

/**
 * What all live grants reach together (consent-model.md §4, decision 10).
 * Each grant is reasonable on its own; the union is what an owner can't see
 * from per-grant cards. Pure, so the page and the tests agree on "live".
 *
 * Counts only: there's no list of served questions. A per-grant table of
 * question ids would link the owner to the Anon questions they were served,
 * in plaintext D1, which is exactly what anon_attributions seals.
 */
export interface Reach {
  /** Grants neither revoked nor expired. */
  live: number;
  /** Highest ceiling among live grants, and which grants give it. */
  ceiling: Tier | null;
  ceiling_via: string[];
  /** '*' if any live grant covers every topic. */
  domains: '*' | string[];
  /** Live grants serving answers themselves (and so to the agent's model provider). */
  raw_via: string[];
  /** Quiz results reachable: private ones need Secret, and a domain-scoped grant gets none (context.ts `measuredFor`). */
  quiz_results: 'all' | 'public' | 'none';
}

export interface RecentReads {
  days: number;
  reads: number;
  answers: number;
  max_tier: Tier | null;
  /** Grants that read anything in the window, revoked ones included. */
  grants: number;
}

export const REACH_DAYS = 30;

const nameOf = (g: GrantRow) => g.label ?? (g.key_hint ? `…${g.key_hint}` : 'unnamed key');

export function isLive(g: GrantRow, now: number): boolean {
  return g.revoked_at === null && (g.expires_at === null || g.expires_at > now);
}

export function combinedReach(rows: GrantRow[], now: number): Reach {
  const live = rows.filter((g) => isLive(g, now));
  const grants = live.map((g) => ({ row: g, grant: toGrant(g) }));
  let ceiling: Tier | null = null;
  for (const { grant } of grants) if (ceiling === null || TIERS.indexOf(grant.ceiling) > TIERS.indexOf(ceiling)) ceiling = grant.ceiling;
  const domains: Reach['domains'] = grants.some(({ grant }) => grant.domains === '*')
    ? '*'
    : [...new Set(grants.flatMap(({ grant }) => (grant.domains === '*' ? [] : grant.domains)))].sort();
  const allTopics = grants.filter(({ grant }) => grant.domains === '*');
  return {
    live: live.length,
    ceiling,
    ceiling_via: grants.filter(({ grant }) => grant.ceiling === ceiling).map(({ row }) => nameOf(row)),
    domains,
    raw_via: grants.filter(({ grant }) => grant.disclosure === 'raw').map(({ row }) => nameOf(row)),
    quiz_results: allTopics.some(({ grant }) => grant.ceiling === 'Secret') ? 'all' : allTopics.length > 0 ? 'public' : 'none',
  };
}

/** Reads across every grant the owner has had, in the last `days`. */
export async function recentReads(env: Env, ownerKey: number, now: number, days = REACH_DAYS): Promise<RecentReads> {
  const rows = ((await env.DB.prepare(
    `SELECT r.max_tier, COUNT(*) AS n, COALESCE(SUM(r.answer_count), 0) AS answers
       FROM grant_reads r JOIN grants g ON g.id = r.grant_id
      WHERE g.owner_key = ? AND r.at >= ? GROUP BY r.max_tier`,
  ).bind(ownerKey, now - days * 86_400_000).all()).results ?? []) as Array<{ max_tier: string | null; n: number; answers: number }>;
  const distinct = await env.DB.prepare(
    `SELECT COUNT(DISTINCT r.grant_id) AS g FROM grant_reads r JOIN grants g ON g.id = r.grant_id WHERE g.owner_key = ? AND r.at >= ?`,
  ).bind(ownerKey, now - days * 86_400_000).first() as { g: number } | null;
  return {
    days,
    reads: rows.reduce((s, r) => s + r.n, 0),
    answers: rows.reduce((s, r) => s + r.answers, 0),
    max_tier: maxTier(rows.filter((r) => r.max_tier && r.answers > 0).map((r) => r.max_tier as string)),
    grants: distinct?.g ?? 0,
  };
}

/** Forward-only: what was read stays with whoever read it. */
export async function revokeGrant(env: Env, ownerKey: number, id: string): Promise<boolean> {
  const r = await env.DB.prepare('UPDATE grants SET revoked_at = ? WHERE id = ? AND owner_key = ? AND revoked_at IS NULL')
    .bind(Date.now(), id, ownerKey).run();
  return (r.meta?.changes ?? 0) > 0;
}
