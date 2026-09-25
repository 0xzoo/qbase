/**
 * Account backfill planner (docs/specs/account-root.md §5).
 *
 * Pure: takes a read-only snapshot of prod's identity columns and returns the
 * SQL that fills `accounts`, `account_credentials` and `account_id_seq`, plus
 * the checks to run afterwards. Shared by scripts/accounts-backfill.ts and the
 * tests, so what is tested is what is emitted.
 *
 * Rules the emitted SQL keeps:
 *  - insert-only into the three new tables (`INSERT OR IGNORE`, and one
 *    upsert on the sequence); no statement touches a pre-existing table;
 *  - re-runnable: a second run inserts nothing and allocates nothing;
 *  - set-based where it can be (Users, data-only fids, linked passkeys), so
 *    rows created between emit and apply are still covered; explicit ids only
 *    for the passkey addresses that have no account, which is the one place a
 *    new id is minted.
 *
 * The planner refuses (throws) on any ambiguity instead of guessing.
 */

export interface BackfillSnapshot {
  /** Tables that exist in the target database. */
  tables: string[];
  users: Array<{ fid: number; quil_address: string | null }>;
  passkeyUsers: Array<{ address: string; fid: number | null }>;
  /** Negative user keys found in data tables that have no Users row. */
  orphanNegativeKeys: number[];
  /** Smallest user key found anywhere in the data tables (0 if none below 0). */
  minDataKey: number;
  /** Present on a re-run: what the new tables already hold. */
  existingAccounts?: Array<{ id: number }>;
  existingCredentials?: Array<{ kind: string; value: string; account_id: number }>;
  existingSeqNext?: number | null;
}

export interface BackfillPlan {
  statements: string[];
  allocations: Array<{ address: string; accountId: number }>;
  checks: Array<{ name: string; sql: string; expect: number }>;
}

/** Data columns that carry a Farcaster fid as a user key. Only tables present in the snapshot are used. */
export const USER_KEY_COLUMNS: Array<[table: string, column: string]> = [
  ['Answers', 'user_id'],
  ['quiz_completions', 'user_id'],
  ['answer_meta', 'responder_fid'],
  ['polls', 'author_fid'],
  ['poll_options', 'created_by_fid'],
  ['council_summons', 'fid'],
  ['answer_likes', 'user_fid'],
  ['bartlet_airdrops', 'fid'],
  ['bartlet_unlocks', 'fid'],
  ['quiz_airdrops', 'fid'],
  ['inquiry_responses', 'fid'],
  ['direct_queries', 'sender_id'],
  ['direct_queries', 'recipient_id'],
  ['queries', 'coiner_fid'],
  ['question_meta', 'author_fid'],
  ['user_signers', 'fid'],
  ['beta_whitelist', 'fid'],
  ['qbase_follows', 'follower_fid'],
  ['qbase_follows', 'following_fid'],
  ['passkey_users', 'fid'],
];

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

export function planBackfill(snap: BackfillSnapshot, now: number): BackfillPlan {
  if (!Number.isInteger(now) || now <= 0) throw new Error('now must be a positive integer (ms)');
  const has = (t: string) => snap.tables.some(x => x.toLowerCase() === t.toLowerCase());
  if (!has('Users') || !has('passkey_users')) throw new Error('snapshot is missing Users or passkey_users');

  if (snap.orphanNegativeKeys.length) {
    throw new Error(`negative user keys with no Users row: ${snap.orphanNegativeKeys.join(', ')} — resolve by hand before backfilling`);
  }
  if (snap.users.some(u => u.fid === 0)) throw new Error('a Users row has fid 0');

  // ── Passkey resolution, and every way it can be ambiguous ────────────────
  const quilOwners = new Map<string, number[]>();
  for (const u of snap.users) {
    if (!u.quil_address) continue;
    quilOwners.set(u.quil_address, [...(quilOwners.get(u.quil_address) ?? []), u.fid]);
  }
  for (const [addr, fids] of quilOwners) {
    if (fids.length > 1) throw new Error(`quil_address ${addr} is on several Users rows: ${fids.join(', ')}`);
  }
  const existingCred = new Map((snap.existingCredentials ?? []).map(c => [`${c.kind}|${c.value}`, c.account_id]));

  const unresolved: string[] = [];
  const seenAddr = new Set<string>();
  for (const p of snap.passkeyUsers) {
    if (seenAddr.has(p.address)) throw new Error(`passkey address ${p.address} appears twice`);
    seenAddr.add(p.address);
    const viaUsers = quilOwners.get(p.address)?.[0];
    if (p.fid != null && viaUsers != null && viaUsers !== p.fid) {
      throw new Error(`passkey ${p.address}: passkey_users says fid ${p.fid}, Users.quil_address says ${viaUsers}`);
    }
    const intended = p.fid ?? viaUsers;
    const already = existingCred.get(`passkey|${p.address}`);
    if (already != null && intended != null && already !== intended) {
      throw new Error(`passkey ${p.address}: already credentialed to ${already}, snapshot resolves to ${intended}`);
    }
    if (intended == null && already == null) unresolved.push(p.address);
  }

  // ── Allocation: strictly below every id and key in sight ─────────────────
  const floor = Math.min(
    0,
    ...snap.users.map(u => u.fid),
    snap.minDataKey,
    ...(snap.existingAccounts ?? []).map(a => a.id),
    snap.existingSeqNext != null ? snap.existingSeqNext + 1 : 0,
  );
  const allocations = [...unresolved].sort().map((address, i) => ({ address, accountId: floor - 1 - i }));

  // ── Statements ───────────────────────────────────────────────────────────
  const statements: string[] = [];
  statements.push(
    `INSERT OR IGNORE INTO accounts (id, born_from, created_at)
SELECT fid, CASE WHEN fid > 0 THEN 'farcaster' ELSE 'legacy' END, ${now}
FROM Users WHERE typeof(fid) = 'integer' AND fid <> 0;`,
  );
  for (const [table, column] of USER_KEY_COLUMNS) {
    if (!has(table)) continue;
    statements.push(
      `INSERT OR IGNORE INTO accounts (id, born_from, created_at)
SELECT DISTINCT ${column}, 'farcaster', ${now}
FROM ${table} WHERE typeof(${column}) = 'integer' AND ${column} > 0;`,
    );
  }
  statements.push(
    `INSERT OR IGNORE INTO account_credentials (kind, value, account_id, label, created_at)
SELECT 'farcaster', CAST(a.id AS TEXT), a.id, u.fname, ${now}
FROM accounts a LEFT JOIN Users u ON u.fid = a.id WHERE a.id > 0;`,
  );
  statements.push(
    `INSERT OR IGNORE INTO account_credentials (kind, value, account_id, label, created_at)
SELECT 'passkey', address, fid, display_name, ${now}
FROM passkey_users WHERE fid IS NOT NULL;`,
  );
  statements.push(
    `INSERT OR IGNORE INTO account_credentials (kind, value, account_id, label, created_at)
SELECT 'passkey', quil_address, fid, NULL, ${now}
FROM Users WHERE quil_address IS NOT NULL AND quil_address <> '';`,
  );
  for (const { address, accountId } of allocations) {
    statements.push(`INSERT OR IGNORE INTO accounts (id, born_from, created_at) VALUES (${accountId}, 'passkey', ${now});`);
    statements.push(
      `INSERT OR IGNORE INTO account_credentials (kind, value, account_id, label, created_at)
SELECT 'passkey', address, ${accountId}, display_name, ${now} FROM passkey_users WHERE address = ${q(address)};`,
    );
  }
  statements.push(
    `INSERT INTO account_id_seq (id, next) SELECT 1, MIN(COALESCE(MIN(id), 0), 0) - 1 FROM accounts WHERE 1
ON CONFLICT(id) DO UPDATE SET next = MIN(account_id_seq.next, excluded.next);`,
  );

  return { statements, allocations, checks: verificationChecks(has) };
}

export function verificationChecks(has: (t: string) => boolean): BackfillPlan['checks'] {
  const checks: BackfillPlan['checks'] = [
    { name: 'users_without_account', expect: 0, sql: `SELECT COUNT(*) AS n FROM Users u LEFT JOIN accounts a ON a.id = u.fid WHERE a.id IS NULL AND u.fid <> 0` },
    { name: 'positive_account_without_own_fc_credential', expect: 0, sql: `SELECT COUNT(*) AS n FROM accounts a LEFT JOIN account_credentials c ON c.kind = 'farcaster' AND c.value = CAST(a.id AS TEXT) AND c.account_id = a.id WHERE a.id > 0 AND c.value IS NULL` },
    { name: 'passkey_without_credential', expect: 0, sql: `SELECT COUNT(*) AS n FROM passkey_users p LEFT JOIN account_credentials c ON c.kind = 'passkey' AND c.value = p.address WHERE c.value IS NULL` },
    { name: 'passkey_credential_disagrees_with_link', expect: 0, sql: `SELECT COUNT(*) AS n FROM passkey_users p JOIN account_credentials c ON c.kind = 'passkey' AND c.value = p.address WHERE p.fid IS NOT NULL AND c.account_id <> p.fid` },
    { name: 'credential_to_missing_account', expect: 0, sql: `SELECT COUNT(*) AS n FROM account_credentials c LEFT JOIN accounts a ON a.id = c.account_id WHERE a.id IS NULL` },
    { name: 'farcaster_credential_to_other_account', expect: 0, sql: `SELECT COUNT(*) AS n FROM account_credentials c WHERE c.kind = 'farcaster' AND CAST(c.value AS INTEGER) > 0 AND c.account_id > 0 AND c.account_id <> CAST(c.value AS INTEGER)` },
    { name: 'seq_not_below_all_ids', expect: 0, sql: `SELECT COUNT(*) AS n FROM account_id_seq s WHERE s.next >= (SELECT MIN(COALESCE(MIN(id), 0), 0) FROM accounts)` },
    { name: 'seq_rows', expect: 1, sql: `SELECT COUNT(*) AS n FROM account_id_seq` },
  ];
  for (const [table, column] of USER_KEY_COLUMNS) {
    if (!has(table)) continue;
    checks.push({
      name: `${table}.${column}_without_account`,
      expect: 0,
      sql: `SELECT COUNT(DISTINCT x.${column}) AS n FROM ${table} x LEFT JOIN accounts a ON a.id = x.${column} WHERE typeof(x.${column}) = 'integer' AND x.${column} > 0 AND a.id IS NULL`,
    });
  }
  return checks;
}

/** Row counts of every pre-existing table the backfill reads; must be identical before and after. */
export function untouchedTables(has: (t: string) => boolean): string[] {
  return [...new Set(['Users', 'passkey_users', 'anon_attributions', ...USER_KEY_COLUMNS.map(([t]) => t)])].filter(has);
}
