/**
 * Account backfill (docs/specs/account-root.md §5). Never writes to D1.
 *
 *   npx --yes tsx scripts/accounts-backfill.ts [--db=prod|dev]            emit + rehearse
 *   npx --yes tsx scripts/accounts-backfill.ts [--db=prod|dev] --verify   run the checks against D1
 *
 * Emit reads identity columns only (fids, passkey addresses, names; no answer
 * content) through `wrangler d1 execute --remote --json`, plans the backfill,
 * then REHEARSES it in an in-memory SQLite (node:sqlite) loaded with those
 * columns: migration 0076, the emitted statements twice, every verification
 * check, and a row-count comparison of every pre-existing table. It refuses to
 * write the SQL file if any of that fails.
 *
 * Output: scripts/out/accounts-backfill-<db>-<ts>.sql and .json (git-ignored).
 * Applying is a separate, deliberate step by a human:
 *   npx wrangler d1 execute prod-qbase --remote --file scripts/out/<file>.sql
 * then `--verify`.
 */

import { execFileSync } from 'child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { DatabaseSync } from 'node:sqlite';
import {
  planBackfill, verificationChecks, untouchedTables, USER_KEY_COLUMNS, type BackfillSnapshot,
} from '../worker/services/accounts/backfillPlan';

const args = new Map(process.argv.slice(2).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? 'true']; }));
const which = args.get('db') ?? 'prod';
if (which !== 'prod' && which !== 'dev') throw new Error('--db must be prod or dev');
const DB = which === 'prod' ? 'prod-qbase' : 'dev-qbase';
const CONFIG = which === 'prod' ? 'wrangler.jsonc' : 'wrangler.dev.jsonc';

type Row = Record<string, unknown>;
function d1(sql: string): Row[] {
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', DB, '--remote', '--json', '--config', CONFIG, '--command', sql], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024,
  });
  const parsed = JSON.parse(out.slice(out.indexOf('[')));
  return parsed[0].results as Row[];
}

const tables = d1(`SELECT name FROM sqlite_master WHERE type = 'table'`).map(r => String(r.name));
const has = (t: string) => tables.some(x => x.toLowerCase() === t.toLowerCase());

if (args.has('verify')) {
  let failed = 0;
  for (const c of verificationChecks(has)) {
    const n = Number(d1(c.sql)[0].n);
    const ok = n === c.expect;
    if (!ok) failed += 1;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${c.name}: ${n} (expect ${c.expect})`);
  }
  for (const t of untouchedTables(has)) console.log(`rows ${t}: ${d1(`SELECT COUNT(*) AS n FROM ${t}`)[0].n}`);
  process.exit(failed ? 1 : 0);
}

// ── Snapshot (identity columns only) ─────────────────────────────────────────
const users = d1(`SELECT fid, quil_address, fname FROM Users`) as Array<{ fid: number; quil_address: string | null; fname: string | null }>;
const passkeyUsers = d1(`SELECT address, fid, display_name FROM passkey_users`) as Array<{ address: string; fid: number | null; display_name: string | null }>;
const columnValues = new Map<string, unknown[]>();
for (const [t, c] of USER_KEY_COLUMNS) {
  if (!has(t)) continue;
  columnValues.set(`${t}.${c}`, d1(`SELECT DISTINCT ${c} AS v FROM ${t} WHERE ${c} IS NOT NULL`).map(r => r.v));
}
const prodCounts = Object.fromEntries(untouchedTables(has).map(t => [t, Number(d1(`SELECT COUNT(*) AS n FROM ${t}`)[0].n)]));

const userFids = new Set(users.map(u => u.fid));
const dataKeys = [...columnValues.values()].flat().filter((v): v is number => typeof v === 'number' && Number.isInteger(v));
const nonIntegerKeys = [...columnValues.entries()].flatMap(([k, vs]) => vs.filter(v => typeof v !== 'number').map(v => `${k}=${JSON.stringify(v)}`));
const snapshot: BackfillSnapshot = {
  tables,
  users: users.map(u => ({ fid: u.fid, quil_address: u.quil_address })),
  passkeyUsers: passkeyUsers.map(p => ({ address: p.address, fid: p.fid })),
  orphanNegativeKeys: [...new Set(dataKeys.filter(k => k < 0 && !userFids.has(k)))],
  minDataKey: Math.min(0, ...dataKeys),
};
if (has('accounts')) {
  snapshot.existingAccounts = d1(`SELECT id FROM accounts`) as Array<{ id: number }>;
  snapshot.existingCredentials = d1(`SELECT kind, value, account_id FROM account_credentials`) as BackfillSnapshot['existingCredentials'];
  const s = d1(`SELECT next FROM account_id_seq WHERE id = 1`);
  snapshot.existingSeqNext = s.length ? Number(s[0].next) : null;
}

const now = Date.now();
const plan = planBackfill(snapshot, now);

// ── Rehearsal in memory ──────────────────────────────────────────────────────
const mem = new DatabaseSync(':memory:');
mem.exec(`CREATE TABLE Users (fid INTEGER PRIMARY KEY, quil_address TEXT, fname TEXT)`);
mem.exec(`CREATE TABLE passkey_users (address TEXT PRIMARY KEY, fid INTEGER, display_name TEXT)`);
mem.exec(`CREATE TABLE anon_attributions (id TEXT PRIMARY KEY)`);
const byTable = new Map<string, string[]>();
for (const [t, c] of USER_KEY_COLUMNS) if (has(t) && t !== 'passkey_users') byTable.set(t, [...(byTable.get(t) ?? []), c]);
for (const [t, cols] of byTable) mem.exec(`CREATE TABLE ${t} (${cols.map(c => `${c} INTEGER`).join(', ')})`);
const insUser = mem.prepare(`INSERT INTO Users (fid, quil_address, fname) VALUES (?, ?, ?)`);
for (const u of users) insUser.run(u.fid, u.quil_address, u.fname);
const insPk = mem.prepare(`INSERT INTO passkey_users (address, fid, display_name) VALUES (?, ?, ?)`);
for (const p of passkeyUsers) insPk.run(p.address, p.fid, p.display_name);
for (const [t, cols] of byTable) {
  for (const c of cols) {
    const ins = mem.prepare(`INSERT INTO ${t} (${c}) VALUES (?)`);
    for (const v of columnValues.get(`${t}.${c}`) ?? []) ins.run(v as number);
  }
}
if (snapshot.existingAccounts) {
  // A re-run: carry what prod's new tables already hold into the rehearsal.
  mem.exec(readFileSync('migrations/0076_accounts.sql', 'utf8'));
  const a = mem.prepare(`INSERT INTO accounts (id, born_from, created_at) VALUES (?, 'existing', 0)`);
  for (const r of snapshot.existingAccounts) a.run(r.id);
  const c = mem.prepare(`INSERT INTO account_credentials (kind, value, account_id, created_at) VALUES (?, ?, ?, 0)`);
  for (const r of snapshot.existingCredentials ?? []) c.run(r.kind, r.value, r.account_id);
  if (snapshot.existingSeqNext != null) mem.prepare(`INSERT INTO account_id_seq (id, next) VALUES (1, ?)`).run(snapshot.existingSeqNext);
}
const memTables = mem.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map(r => String(r.name));
const memHas = (t: string) => memTables.some(x => x.toLowerCase() === t.toLowerCase());
const countAll = () => Object.fromEntries(untouchedTables(memHas).map(t => [t, Number((mem.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as Row).n)]));
const dumpNew = () => JSON.stringify([
  mem.prepare(`SELECT * FROM accounts ORDER BY id`).all(),
  mem.prepare(`SELECT * FROM account_credentials ORDER BY kind, value`).all(),
  mem.prepare(`SELECT * FROM account_id_seq`).all(),
]);

const before = countAll();
mem.exec(readFileSync('migrations/0076_accounts.sql', 'utf8'));
for (const s of plan.statements) mem.exec(s);
const afterFirst = dumpNew();
for (const s of plan.statements) mem.exec(s);
const afterSecond = dumpNew();
const after = countAll();

const failures: string[] = [];
if (afterFirst !== afterSecond) failures.push('second run changed the new tables (not idempotent)');
if (JSON.stringify(before) !== JSON.stringify(after)) failures.push(`pre-existing row counts changed: ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
const checkResults = verificationChecks(memHas).map(c => ({ ...c, got: Number((mem.prepare(c.sql).get() as Row).n) }));
for (const c of checkResults) if (c.got !== c.expect) failures.push(`check ${c.name}: ${c.got} (expect ${c.expect})`);

const summary = {
  db: DB,
  generated_at: new Date(now).toISOString(),
  prod_row_counts: prodCounts,
  users: users.length,
  users_negative: users.filter(u => u.fid < 0).map(u => u.fid),
  passkey_users: passkeyUsers.length,
  allocations: plan.allocations,
  non_integer_user_keys_ignored: nonIntegerKeys,
  rehearsal: {
    accounts: Number((mem.prepare(`SELECT COUNT(*) AS n FROM accounts`).get() as Row).n),
    accounts_positive: Number((mem.prepare(`SELECT COUNT(*) AS n FROM accounts WHERE id > 0`).get() as Row).n),
    accounts_negative: Number((mem.prepare(`SELECT COUNT(*) AS n FROM accounts WHERE id < 0`).get() as Row).n),
    accounts_without_users_row: Number((mem.prepare(`SELECT COUNT(*) AS n FROM accounts a LEFT JOIN Users u ON u.fid = a.id WHERE u.fid IS NULL`).get() as Row).n),
    credentials_by_kind: mem.prepare(`SELECT kind, COUNT(*) AS n FROM account_credentials GROUP BY kind`).all(),
    seq_next: (mem.prepare(`SELECT next FROM account_id_seq`).get() as Row | undefined)?.next ?? null,
    checks: checkResults.map(c => ({ name: c.name, got: c.got, expect: c.expect })),
    idempotent: afterFirst === afterSecond,
    pre_existing_counts_unchanged: JSON.stringify(before) === JSON.stringify(after),
  },
  failures,
};

mkdirSync('scripts/out', { recursive: true });
const stem = `scripts/out/accounts-backfill-${which}-${new Date(now).toISOString().replace(/[:.]/g, '-')}`;
writeFileSync(`${stem}.json`, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary.rehearsal, null, 2));
console.log('allocations:', JSON.stringify(plan.allocations));
if (nonIntegerKeys.length) console.log('ignored non-integer user keys:', nonIntegerKeys.slice(0, 20));
if (failures.length) {
  console.error('REFUSING TO EMIT:\n  ' + failures.join('\n  '));
  console.error(`report: ${stem}.json`);
  process.exit(1);
}
const header = `-- accounts backfill for ${DB}, planned ${summary.generated_at}\n-- rehearsed in memory: idempotent, pre-existing tables unchanged, ${checkResults.length} checks passed\n-- apply: npx wrangler d1 execute ${DB} --remote --config ${CONFIG} --file ${stem}.sql\n\n`;
writeFileSync(`${stem}.sql`, header + plan.statements.join('\n\n') + '\n');
console.log(`\nemitted ${stem}.sql\nreport  ${stem}.json`);
