/**
 * SQL for the account migration (docs/specs/account-root.md §5–§6, option 2).
 *
 * Pure builders shared by the admin route (which runs them in the Worker) and
 * the rehearsal script / tests (which run them against SQLite), so what is
 * rehearsed is what runs.
 *
 * Every statement is idempotent because account ids live in [2^40, 2^53) and
 * every pre-rewrite key is < 2^40: a statement only ever selects values below
 * ACCOUNT_ID_MIN, and after it runs there are none left for it to select.
 */

export const ACCOUNT_ID_MIN = 1_099_511_627_776;        // 2^40
const ACCOUNT_ID_SPAN = 9_006_099_743_113_216;          // 2^53 - 2^40
/** A fresh random account id, evaluated per row. `random() % n` stays in (-n, n), so abs() cannot overflow. */
export const RANDOM_ACCOUNT_ID_SQL = `(${ACCOUNT_ID_MIN} + abs(random() % ${ACCOUNT_ID_SPAN}))`;

/**
 * Keys below this are ambiguous in prod: legacy internal ids from an older
 * Users table (1, 2, 3, 10, 12, 13) sit in columns that otherwise hold fids,
 * and fids 1–99 are real Farcaster accounts. Such keys get an account
 * (born_from 'legacy') but no farcaster credential; the status phase lists
 * them for a human to resolve.
 */
export const AMBIGUOUS_KEY_BELOW = 100;
/** The pre-sealing anon placeholder (`anon_id` in src/lib/consts.ts); maps to the @4n0n account. */
export const LEGACY_ANON_KEY = 3;

/** Person-key columns: rewritten fid → account id through accounts.legacy_key. */
export const PERSON_KEY_COLUMNS: ReadonlyArray<readonly [table: string, column: string]> = [
  ['Users', 'fid'],
  ['Answers', 'user_id'],
  ['quiz_completions', 'user_id'],
  ['answer_likes', 'user_fid'],
  ['qbase_follows', 'follower_fid'],
  ['qbase_follows', 'following_fid'],
  ['council_summons', 'fid'],
  ['polls', 'author_fid'],
  ['poll_options', 'created_by_fid'],
  ['direct_queries', 'sender_id'],
  ['direct_queries', 'recipient_id'],
  ['direct_query_responses', 'recipient_id'],
  ['bartlet_airdrops', 'fid'],
  ['bartlet_unlocks', 'fid'],
  ['quiz_airdrops', 'fid'],
  ['inquiry_responses', 'fid'],
  ['temporary_answers', 'user_id'],
] as const;

/** Text columns that hold a person key as a decimal string (or a passkey address). */
export const PERSON_KEY_TEXT_COLUMNS: ReadonlyArray<readonly [table: string, column: string]> = [
  ['follows', 'follower_id'],
  ['follows', 'followee_id'],
  ['answer_likes', 'user_id'],
] as const;

/** Farcaster-fact columns used only as sources of fids that deserve an account (never rewritten). */
export const FID_SOURCE_COLUMNS: ReadonlyArray<readonly [table: string, column: string]> = [
  ['passkey_users', 'fid'],
  ['queries', 'coiner_fid'],
] as const;

export type Has = (table: string) => boolean;

const keyFilter = (col: string) =>
  `typeof(${col}) = 'integer' AND ${col} <> 0 AND ${col} < ${ACCOUNT_ID_MIN}`;

/** Refuse to start while these are non-zero: they are the ambiguities a human must settle first. */
export function preflightChecks(has: Has): Array<{ name: string; sql: string }> {
  const out: Array<{ name: string; sql: string }> = [];
  if (has('Users')) {
    out.push({
      name: 'quil_address_on_several_users',
      sql: `SELECT COUNT(*) AS n FROM (SELECT quil_address FROM Users WHERE quil_address IS NOT NULL AND quil_address <> '' GROUP BY quil_address HAVING COUNT(*) > 1)`,
    });
  }
  if (has('Users') && has('passkey_users')) {
    out.push({
      name: 'passkey_link_disagrees_with_users',
      sql: `SELECT COUNT(*) AS n FROM passkey_users p JOIN Users u ON u.quil_address = p.address
            WHERE p.fid IS NOT NULL AND u.fid <> p.fid AND u.fid < ${ACCOUNT_ID_MIN}`,
    });
  }
  return out;
}

/** Phase `accounts`: an account for every unmapped key, plus farcaster and passkey credentials. */
export function accountsStatements(has: Has, now: number): string[] {
  const s: string[] = [];
  const sources = [...PERSON_KEY_COLUMNS, ...FID_SOURCE_COLUMNS].filter(([t]) => has(t));
  for (const [t, c] of sources) {
    s.push(`INSERT OR IGNORE INTO accounts (id, born_from, legacy_key, created_at)
SELECT ${RANDOM_ACCOUNT_ID_SQL}, CASE WHEN k >= ${AMBIGUOUS_KEY_BELOW} THEN 'farcaster' ELSE 'legacy' END, k, ${now}
FROM (SELECT DISTINCT ${c} AS k FROM ${t} WHERE ${keyFilter(c)} AND ${c} <> ${LEGACY_ANON_KEY})
WHERE k NOT IN (SELECT legacy_key FROM accounts WHERE legacy_key IS NOT NULL);`);
  }
  for (const [t, c] of PERSON_KEY_TEXT_COLUMNS.filter(([t]) => has(t))) {
    s.push(`INSERT OR IGNORE INTO accounts (id, born_from, legacy_key, created_at)
SELECT ${RANDOM_ACCOUNT_ID_SQL}, CASE WHEN k >= ${AMBIGUOUS_KEY_BELOW} THEN 'farcaster' ELSE 'legacy' END, k, ${now}
FROM (SELECT DISTINCT CAST(${c} AS INTEGER) AS k FROM ${t}
      WHERE ${c} GLOB '[0-9]*' AND ${c} NOT GLOB '*[^0-9]*' AND length(${c}) < 13)
WHERE k <> 0 AND k <> ${LEGACY_ANON_KEY} AND k NOT IN (SELECT legacy_key FROM accounts WHERE legacy_key IS NOT NULL);`);
  }
  s.push(`INSERT OR IGNORE INTO account_credentials (kind, value, account_id, label, created_at)
SELECT 'farcaster', CAST(a.legacy_key AS TEXT), a.id, (SELECT u.fname FROM Users u WHERE u.fid IN (a.legacy_key, a.id) LIMIT 1), ${now}
FROM accounts a WHERE a.born_from = 'farcaster' AND a.legacy_key >= ${AMBIGUOUS_KEY_BELOW};`);
  if (has('passkey_users')) {
    s.push(`INSERT OR IGNORE INTO account_credentials (kind, value, account_id, label, created_at)
SELECT 'passkey', p.address, c.account_id, p.display_name, ${now}
FROM passkey_users p JOIN account_credentials c ON c.kind = 'farcaster' AND c.value = CAST(p.fid AS TEXT)
WHERE p.fid IS NOT NULL;`);
  }
  s.push(`INSERT OR IGNORE INTO account_credentials (kind, value, account_id, label, created_at)
SELECT 'passkey', u.quil_address, a.id, NULL, ${now}
FROM Users u JOIN accounts a ON a.legacy_key = u.fid OR a.id = u.fid
WHERE u.quil_address IS NOT NULL AND u.quil_address <> '';`);
  s.push(`INSERT OR IGNORE INTO account_migration (id, state, rewritten_at) VALUES (1, 'accounts', NULL);`);
  return s;
}

/** Passkey addresses that still have no account after the set-based statements (minted one by one in JS). */
export const UNLINKED_PASSKEYS_SQL = `SELECT p.address, p.display_name FROM passkey_users p
LEFT JOIN account_credentials c ON c.kind = 'passkey' AND c.value = p.address
WHERE c.value IS NULL ORDER BY p.address`;

const QUERIES_REWRITE_WHERE = `typeof(coiner_id) = 'integer' AND coiner_id <> 0 AND coiner_id < ${ACCOUNT_ID_MIN} AND coiner_fid IS NOT NULL
  AND EXISTS (SELECT 1 FROM account_credentials WHERE kind = 'farcaster' AND value = CAST(queries.coiner_fid AS TEXT))`;

/** A text person key that maps: a numeric key with an account, or a passkey address with a credential. */
function textRewriteWhere(_table: string, c: string): string {
  return `((${c} GLOB '[0-9]*' AND ${c} NOT GLOB '*[^0-9]*' AND length(${c}) < 13
    AND CAST(${c} AS INTEGER) IN (SELECT legacy_key FROM accounts WHERE legacy_key IS NOT NULL))
  OR ${c} IN (SELECT value FROM account_credentials WHERE kind = 'passkey'))`;
}

/**
 * The anon placeholders on `Answers.user_id` (the @4n0n fid and the legacy
 * anon id) are sentinels meaning "no author", not person keys: they are never
 * rewritten, so every anon read and write path keeps working unchanged.
 */
export function sentinelFilter(table: string, column: string, anonFid: number): string {
  return table === 'Answers' && column === 'user_id' ? ` AND ${column} NOT IN (${LEGACY_ANON_KEY}, ${Number(anonFid)})` : '';
}
const coinerAccountSql = `(SELECT account_id FROM account_credentials WHERE kind = 'farcaster' AND value = CAST(queries.coiner_fid AS TEXT))`;

/**
 * Phase `rewrite`: the cutover. Meant to run as ONE D1 batch (a transaction):
 * the log of non-invertible values, every person-key rewrite, and the state flip.
 */
export function rewriteStatements(has: Has, anonFid: number, now: number): string[] {
  const s: string[] = [];
  // Log first, so the log and the rewrite commit together.
  if (has('queries')) {
    for (const col of ['coiner_id', 'owner_id']) {
      s.push(`INSERT OR IGNORE INTO account_rewrite_log (tbl, row_key, col, old_value)
SELECT 'queries', id, '${col}', ${col} FROM queries
WHERE ${QUERIES_REWRITE_WHERE};`);
    }
  }
  for (const [t, c] of PERSON_KEY_TEXT_COLUMNS.filter(([t]) => has(t))) {
    s.push(`INSERT OR IGNORE INTO account_rewrite_log (tbl, row_key, col, old_value)
SELECT '${t}', CAST(rowid AS TEXT), '${c}', ${c} FROM ${t} WHERE ${textRewriteWhere(t, c)};`);
  }
  for (const [t, c] of PERSON_KEY_COLUMNS.filter(([t]) => has(t))) {
    s.push(`UPDATE ${t} SET ${c} = (SELECT id FROM accounts WHERE legacy_key = ${t}.${c})
WHERE ${keyFilter(c)}${sentinelFilter(t, c, anonFid)} AND ${c} IN (SELECT legacy_key FROM accounts WHERE legacy_key IS NOT NULL);`);
  }
  if (has('queries')) {
    s.push(`UPDATE queries SET coiner_id = ${coinerAccountSql}, owner_id = ${coinerAccountSql}
WHERE ${QUERIES_REWRITE_WHERE};`);
  }
  for (const [t, c] of PERSON_KEY_TEXT_COLUMNS.filter(([t]) => has(t))) {
    s.push(`UPDATE ${t} SET ${c} = COALESCE(
  CAST((SELECT id FROM accounts WHERE legacy_key = CAST(${t}.${c} AS INTEGER) AND ${t}.${c} NOT GLOB '*[^0-9]*') AS TEXT),
  CAST((SELECT account_id FROM account_credentials WHERE kind = 'passkey' AND value = ${t}.${c}) AS TEXT))
WHERE ${textRewriteWhere(t, c)};`);
  }
  s.push(`UPDATE account_migration SET state = 'rewritten', rewritten_at = ${now} WHERE id = 1;`);
  return s;
}

/** Phase `unrewrite`: the exact inverse of `rewrite`, one batch. Passkey-address text keys come back as the legacy fid string. */
export function unrewriteStatements(has: Has): string[] {
  const s: string[] = [];
  for (const [t, c] of PERSON_KEY_COLUMNS.filter(([t]) => has(t))) {
    s.push(`UPDATE ${t} SET ${c} = (SELECT legacy_key FROM accounts WHERE id = ${t}.${c})
WHERE ${c} >= ${ACCOUNT_ID_MIN} AND ${c} IN (SELECT id FROM accounts WHERE legacy_key IS NOT NULL);`);
  }
  for (const [t, c] of PERSON_KEY_TEXT_COLUMNS.filter(([t]) => has(t))) {
    s.push(`UPDATE ${t} SET ${c} = (SELECT CAST(old_value AS TEXT) FROM account_rewrite_log l WHERE l.tbl = '${t}' AND l.col = '${c}' AND l.row_key = CAST(${t}.rowid AS TEXT))
WHERE CAST(rowid AS TEXT) IN (SELECT row_key FROM account_rewrite_log WHERE tbl = '${t}' AND col = '${c}');`);
  }
  // Logged values win over the generic inverse (question authorship, text keys).
  if (has('queries')) {
    for (const col of ['coiner_id', 'owner_id']) {
      s.push(`UPDATE queries SET ${col} = (SELECT old_value FROM account_rewrite_log l WHERE l.tbl = 'queries' AND l.row_key = queries.id AND l.col = '${col}')
WHERE id IN (SELECT row_key FROM account_rewrite_log WHERE tbl = 'queries' AND col = '${col}');`);
    }
  }
  s.push(`DELETE FROM account_rewrite_log;`);
  s.push(`UPDATE account_migration SET state = 'accounts', rewritten_at = NULL WHERE id = 1;`);
  return s;
}

/** Status counts. After a complete rewrite every `*_legacy_values` is 0. */
export function statusQueries(has: Has, anonFid: number): Array<{ name: string; sql: string }> {
  const q: Array<{ name: string; sql: string }> = [
    { name: 'accounts', sql: `SELECT COUNT(*) AS n FROM accounts` },
    { name: 'accounts_legacy_ambiguous', sql: `SELECT COUNT(*) AS n FROM accounts WHERE born_from = 'legacy'` },
    { name: 'credentials_farcaster', sql: `SELECT COUNT(*) AS n FROM account_credentials WHERE kind = 'farcaster'` },
    { name: 'credentials_passkey', sql: `SELECT COUNT(*) AS n FROM account_credentials WHERE kind = 'passkey'` },
    { name: 'account_ids_out_of_range', sql: `SELECT COUNT(*) AS n FROM accounts WHERE id < ${ACCOUNT_ID_MIN}` },
    { name: 'credentials_to_missing_account', sql: `SELECT COUNT(*) AS n FROM account_credentials c LEFT JOIN accounts a ON a.id = c.account_id WHERE a.id IS NULL` },
  ];
  if (has('passkey_users')) {
    q.push({ name: 'passkeys_without_account', sql: `SELECT COUNT(*) AS n FROM (${UNLINKED_PASSKEYS_SQL})` });
  }
  for (const [t, c] of PERSON_KEY_COLUMNS.filter(([t]) => has(t))) {
    q.push({ name: `${t}.${c}_legacy_values`, sql: `SELECT COUNT(*) AS n FROM ${t} WHERE ${keyFilter(c)}${sentinelFilter(t, c, anonFid)}` });
    q.push({ name: `${t}.${c}_unmapped_keys`, sql: `SELECT COUNT(DISTINCT ${c}) AS n FROM ${t} WHERE ${keyFilter(c)} AND ${c} <> ${LEGACY_ANON_KEY} AND ${c} NOT IN (SELECT legacy_key FROM accounts WHERE legacy_key IS NOT NULL)` });
  }
  if (has('queries')) q.push({ name: 'queries.coiner_id_legacy_values', sql: `SELECT COUNT(*) AS n FROM queries WHERE ${keyFilter('coiner_id')}` });
  return q;
}

/** The ambiguous accounts, for a human: legacy key, and where it appears. */
export const AMBIGUOUS_ACCOUNTS_SQL = `SELECT id, legacy_key FROM accounts WHERE born_from = 'legacy' ORDER BY legacy_key`;
