/**
 * The qbase account as root identity (docs/specs/account-root.md, option 2).
 *
 * An account id is a random integer in [2^40, 2^53). Credentials (farcaster,
 * passkey, ethereum, world) prove you hold an account; a fid is only ever a
 * credential value.
 *
 * Two modes, read from account_migration.state:
 *  - before the cutover (no row, or 'accounts'): the "user key" written to
 *    person-key columns is the fid, exactly as before this change, and
 *    non-Farcaster logins are refused;
 *  - after ('rewritten'): the user key is the account id.
 *
 * Invariants (spec §3.1): a credential belongs to at most one account; an
 * account has at most one farcaster credential; fid F may be linked to an
 * existing account only while F has no account of its own.
 */

import { ACCOUNT_ID_MIN } from './migrationSql';
import { anonTag, anonTagReady } from '../anon/AnonTag';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

export type CredentialKind = 'farcaster' | 'passkey' | 'ethereum' | 'world';
export type MigrationState = 'none' | 'accounts' | 'rewritten';

export interface Credential {
  kind: CredentialKind;
  value: string;
  account_id: number;
  label: string | null;
  created_at: number;
  last_used_at: number | null;
}

export class AccountError extends Error {
  code: string;
  status: number;
  constructor(code: string, status = 409) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

const ACCOUNT_ID_SPAN = 2 ** 53 - 2 ** 40;

/** A fresh random account id in [2^40, 2^53). */
export function randomAccountId(): number {
  const b = crypto.getRandomValues(new Uint32Array(2));
  const r = (b[0] & 0x1fffff) * 2 ** 32 + b[1]; // 53 random bits
  return ACCOUNT_ID_MIN + (r % ACCOUNT_ID_SPAN);
}

export function isAccountId(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= ACCOUNT_ID_MIN;
}

/** Canonical credential values. Every bind goes through these (D1 TEXT binding: never bind a number). */
export function credentialValue(kind: CredentialKind, raw: string | number): string {
  switch (kind) {
    case 'farcaster': {
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isSafeInteger(n) || n <= 0 || n >= ACCOUNT_ID_MIN) throw new AccountError('invalid_fid', 400);
      return String(n);
    }
    case 'ethereum': {
      const s = String(raw).toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(s)) throw new AccountError('invalid_address', 400);
      return s;
    }
    case 'passkey':
    case 'world': {
      const s = String(raw);
      if (!s) throw new AccountError(`invalid_${kind}`, 400);
      return s;
    }
  }
}

// ── Mode (per isolate) ───────────────────────────────────────────────────────
let stateCache: { state: MigrationState; at: number } | null = null;
const STATE_TTL_MS = 10_000;

/** Never throws; a missing table reads as 'none'. 'rewritten' is cached for the isolate's life. */
export async function migrationState(env: Env): Promise<MigrationState> {
  if (stateCache && (stateCache.state === 'rewritten' || Date.now() - stateCache.at < STATE_TTL_MS)) return stateCache.state;
  let state: MigrationState = 'none';
  try {
    const row = await env.DB.prepare('SELECT state FROM account_migration WHERE id = 1').first() as { state: string } | null;
    if (row?.state === 'accounts' || row?.state === 'rewritten') state = row.state;
  } catch {
    state = 'none';
  }
  stateCache = { state, at: Date.now() };
  return state;
}

export async function isRewritten(env: Env): Promise<boolean> {
  return (await migrationState(env)) === 'rewritten';
}

const fidToAccount = new Map<number, number>();

/** Tests and the migration route only. */
export function _resetAccountCaches(): void {
  stateCache = null;
  fidToAccount.clear();
}

// ── Lookups ──────────────────────────────────────────────────────────────────

export async function getCredential(env: Env, kind: CredentialKind, raw: string | number): Promise<Credential | null> {
  const value = credentialValue(kind, raw);
  return (await env.DB.prepare('SELECT * FROM account_credentials WHERE kind = ? AND value = ?').bind(kind, value).first()) as Credential | null;
}

/** The Farcaster fid linked to an account, if any. */
export async function farcasterFidOf(env: Env, accountId: number | undefined): Promise<number | undefined> {
  if (accountId === undefined) return undefined;
  if (!isAccountId(accountId)) return accountId; // before the cutover the key is the fid
  const row = await env.DB.prepare(`SELECT value FROM account_credentials WHERE kind = 'farcaster' AND account_id = ?`).bind(accountId).first() as { value: string } | null;
  return row ? Number(row.value) : undefined;
}

// ── Resolution ───────────────────────────────────────────────────────────────

/**
 * The account for a Farcaster fid (after the cutover); creates it on first
 * sight. legacy_key = fid, so rows an old-mode isolate writes under this fid
 * during the cutover window are swept to this account by a re-run of
 * `rewrite` — unless the fid is an ambiguous legacy key already held by a
 * legacy account, in which case the new account has no legacy_key.
 */
export async function resolveFarcaster(env: Env, fid: number): Promise<number> {
  const cached = fidToAccount.get(fid);
  if (cached !== undefined) return cached;
  const value = credentialValue('farcaster', fid);
  let cred = await getCredential(env, 'farcaster', value);
  if (!cred) {
    const now = Date.now();
    for (let attempt = 0; attempt < 3 && !cred; attempt++) {
      const id = randomAccountId();
      try {
        await env.DB.batch([
          env.DB.prepare(`INSERT INTO accounts (id, born_from, legacy_key, created_at)
            VALUES (?, 'farcaster', CASE WHEN EXISTS (SELECT 1 FROM accounts WHERE legacy_key = ?) THEN NULL ELSE ? END, ?)`).bind(id, fid, fid, now),
          env.DB.prepare(`INSERT INTO account_credentials (kind, value, account_id, created_at, last_used_at) VALUES ('farcaster', ?, ?, ?, ?)`).bind(value, id, now, now),
        ]);
      } catch {
        // Atomic batch: either an id collision (retry) or a concurrent first login won the credential (read it).
      }
      cred = await getCredential(env, 'farcaster', value);
    }
    if (!cred) throw new AccountError('account_create_failed', 503);
  }
  const accountId = Number(cred.account_id);
  fidToAccount.set(fid, accountId);
  return accountId;
}

/**
 * The value to write into person-key columns for a Farcaster identity:
 * the fid before the cutover, its account id after.
 */
export async function userKeyForFid(env: Env, fid: number): Promise<number> {
  return (await isRewritten(env)) ? resolveFarcaster(env, fid) : fid;
}

/**
 * Read-only variant of userKeyForFid for public reads addressed by fid (e.g.
 * /api/users/:fid/answers): never creates an account. Undefined after the
 * cutover when the fid has no account — the caller answers "nothing here".
 */
export async function lookupUserKeyForFid(env: Env, fid: number): Promise<number | undefined> {
  if (!(await isRewritten(env))) return fid;
  const cached = fidToAccount.get(fid);
  if (cached !== undefined) return cached;
  const cred = await getCredential(env, 'farcaster', fid);
  if (!cred) return undefined;
  fidToAccount.set(fid, Number(cred.account_id));
  return Number(cred.account_id);
}

/**
 * The user key for a passkey login. Before the cutover: today's lookup (the
 * Users row holding the address, else the linked fid). After: its credential,
 * or — for a passkey that has none yet — the linked fid's account, else a new
 * passkey-born account.
 */
export async function userKeyForPasskey(env: Env, address: string): Promise<number | undefined> {
  if (!(await isRewritten(env))) {
    const byUsers = await env.DB.prepare('SELECT fid FROM Users WHERE quil_address = ?').bind(address).first() as { fid: number } | null;
    if (byUsers) return Number(byUsers.fid);
    const pk = await env.DB.prepare('SELECT fid FROM passkey_users WHERE address = ?').bind(address).first() as { fid: number | null } | null;
    return pk?.fid ? Number(pk.fid) : undefined;
  }
  const cred = await getCredential(env, 'passkey', address);
  if (cred) return Number(cred.account_id);
  const pk = await env.DB.prepare('SELECT fid, display_name FROM passkey_users WHERE address = ?').bind(address).first() as { fid: number | null; display_name: string | null } | null;
  if (!pk) return undefined;
  if (pk.fid) {
    const accountId = await resolveFarcaster(env, Number(pk.fid));
    await linkCredential(env, accountId, 'passkey', address, pk.display_name);
    return accountId;
  }
  return (await createAccount(env, { kind: 'passkey', value: address, label: pk.display_name, quilAddress: address })).accountId;
}

/** The account a signed-in ethereum address or World subject belongs to, if any (after the cutover). */
export async function accountForCredential(env: Env, kind: CredentialKind, raw: string | number): Promise<number | undefined> {
  if (!(await isRewritten(env))) return undefined;
  const cred = await getCredential(env, kind, raw);
  return cred ? Number(cred.account_id) : undefined;
}

// ── Creation ─────────────────────────────────────────────────────────────────

export interface NewAccount {
  kind: Exclude<CredentialKind, 'farcaster'>;
  value: string;
  label?: string | null;
  fname?: string | null;
  displayName?: string | null;
  quilAddress?: string | null;
}

/**
 * Mint an account for a non-Farcaster credential, with its profile row, in
 * one batch. If the credential was claimed concurrently, returns that account.
 * After the cutover only (before it there is nowhere to put a non-fid key).
 */
export async function createAccount(env: Env, a: NewAccount): Promise<{ accountId: number; created: boolean }> {
  if (!(await isRewritten(env))) throw new AccountError('accounts_not_ready', 503);
  const value = credentialValue(a.kind, a.value);
  const existing = await getCredential(env, a.kind, value);
  if (existing) return { accountId: Number(existing.account_id), created: false };
  const profileSource = a.kind === 'passkey' ? 'passkey' : a.kind;
  for (let attempt = 0; attempt < 3; attempt++) {
    const id = randomAccountId();
    const now = Date.now();
    try {
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO accounts (id, born_from, legacy_key, created_at) VALUES (?, ?, NULL, ?)`).bind(id, a.kind, now),
        env.DB.prepare(`INSERT INTO account_credentials (kind, value, account_id, label, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)`)
          .bind(a.kind, value, id, a.label ?? null, now, now),
        env.DB.prepare(`INSERT INTO Users (fid, fname, display_name, profile_source, quil_address) VALUES (?, ?, ?, ?, ?)`)
          .bind(id, a.fname ?? a.label ?? `${a.kind}-${String(id).slice(-6)}`, a.displayName ?? a.label ?? null, profileSource, a.quilAddress ?? null),
      ]);
      return { accountId: id, created: true };
    } catch {
      const raced = await getCredential(env, a.kind, value);
      if (raced) return { accountId: Number(raced.account_id), created: false };
      // else an id collision: retry with a new id
    }
  }
  throw new AccountError('account_create_failed', 503);
}

// ── Credentials on an account ────────────────────────────────────────────────

export async function listCredentials(env: Env, accountId: number): Promise<Credential[]> {
  const r = await env.DB.prepare('SELECT * FROM account_credentials WHERE account_id = ? ORDER BY created_at').bind(accountId).all();
  return (r.results ?? []) as Credential[];
}

/** Record a login with a credential: refresh its label and last use. */
export async function touchCredential(env: Env, kind: CredentialKind, raw: string | number, label?: string | null): Promise<void> {
  await env.DB.prepare('UPDATE account_credentials SET last_used_at = ?, label = COALESCE(?, label) WHERE kind = ? AND value = ?')
    .bind(Date.now(), label ?? null, kind, credentialValue(kind, raw)).run();
}

/**
 * Attach a proven credential to an account. Same account → refresh; another
 * account → 409 credential_in_use (merge is v2). A fid may be attached only if
 * the account has no fid yet and the fid has no account of its own.
 */
export async function linkCredential(env: Env, accountId: number, kind: CredentialKind, raw: string | number, label?: string | null): Promise<void> {
  const value = credentialValue(kind, raw);
  const existing = await getCredential(env, kind, value);
  if (existing) {
    const holder = Number(existing.account_id);
    if (holder === accountId) {
      await touchCredential(env, kind, value, label);
      return;
    }
    // Someone signed in with World / a wallet / a passkey first, got a fresh
    // account from it, and now links that method to their real account. When
    // the fresh account holds nothing, the method moves and the empty account
    // goes; otherwise it stays refused (merging accounts is out of scope).
    if (kind !== 'farcaster' && await isEmptyAccount(env, holder)) {
      await env.DB.batch([
        env.DB.prepare('UPDATE account_credentials SET account_id = ?, label = COALESCE(?, label), last_used_at = ? WHERE kind = ? AND value = ? AND account_id = ?')
          .bind(accountId, label ?? null, Date.now(), kind, value, holder),
        env.DB.prepare('DELETE FROM Users WHERE fid = ?').bind(holder),
        env.DB.prepare('DELETE FROM accounts WHERE id = ? AND NOT EXISTS (SELECT 1 FROM account_credentials WHERE account_id = ?)').bind(holder, holder),
      ]);
      const moved = await getCredential(env, kind, value);
      if (moved && Number(moved.account_id) === accountId) return;
    }
    throw new AccountError('credential_in_use');
  }
  if (kind === 'farcaster') {
    const has = await env.DB.prepare(`SELECT 1 AS x FROM account_credentials WHERE kind = 'farcaster' AND account_id = ?`).bind(accountId).first();
    if (has) throw new AccountError('account_already_has_farcaster');
    const own = await env.DB.prepare('SELECT 1 AS x FROM accounts WHERE legacy_key = ? AND id <> ?').bind(Number(value), accountId).first();
    if (own) throw new AccountError('credential_in_use');
  }
  const now = Date.now();
  try {
    await env.DB.prepare('INSERT INTO account_credentials (kind, value, account_id, label, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(kind, value, accountId, label ?? null, now, now).run();
  } catch (err) {
    const raced = await getCredential(env, kind, value);
    if (!raced) throw err;
    if (Number(raced.account_id) !== accountId) throw new AccountError('credential_in_use');
  }
  if (kind === 'farcaster') fidToAccount.set(Number(value), accountId);
}

/**
 * An account that holds nothing but one sign-in method: no answers (named or
 * Anon, via its author tags), no quiz completions, no questions or waves. Only
 * such an account may give its method up to another account (linkCredential).
 */
export async function isEmptyAccount(env: Env, accountId: number): Promise<boolean> {
  if (!isAccountId(accountId)) return false;
  const row = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM account_credentials WHERE account_id = ?1) AS creds,
       (SELECT COUNT(*) FROM Answers WHERE user_id = ?1) AS answers,
       (SELECT COUNT(*) FROM quiz_completions WHERE user_id = ?1) AS completions,
       (SELECT COUNT(*) FROM queries WHERE owner_id = ?1 OR coiner_fid = ?1) AS questions,
       (SELECT COUNT(*) FROM polls WHERE author_fid = ?1) AS waves`,
  ).bind(accountId).first() as Record<string, number> | null;
  if (!row || row.creds !== 1 || row.answers || row.completions || row.questions || row.waves) return false;
  if (!(await anonTagReady(env))) return true;
  // Anon rows carry the placeholder; the author is only findable by tag, per question.
  const { results } = await env.DB.prepare(
    "SELECT DISTINCT q_id FROM Answers WHERE audience = 'Anon'",
  ).all() as { results: Array<{ q_id: string }> };
  const tags = await Promise.all((results ?? []).map(r => anonTag(env, accountId, r.q_id)));
  for (let i = 0; i < tags.length; i += 90) {
    const chunk = tags.slice(i, i + 90);
    const hit = await env.DB.prepare(
      `SELECT 1 AS x FROM anon_attributions WHERE type = 'answer' AND author_tag IN (${chunk.map(() => '?').join(',')}) LIMIT 1`,
    ).bind(...chunk).first();
    if (hit) return false;
  }
  return true;
}

/** Remove a credential. Refuses the last one, and (v1) any farcaster credential. */
export async function unlinkCredential(env: Env, accountId: number, kind: CredentialKind, raw: string | number): Promise<void> {
  const value = credentialValue(kind, raw);
  const cred = await getCredential(env, kind, value);
  if (!cred || Number(cred.account_id) !== accountId) throw new AccountError('not_your_credential', 404);
  if (kind === 'farcaster') throw new AccountError('farcaster_unlink_unsupported');
  const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM account_credentials WHERE account_id = ?').bind(accountId).first() as { n: number };
  if (Number(n.n) <= 1) throw new AccountError('last_credential');
  await env.DB.prepare('DELETE FROM account_credentials WHERE kind = ? AND value = ? AND account_id = ?').bind(kind, value, accountId).run();
}
