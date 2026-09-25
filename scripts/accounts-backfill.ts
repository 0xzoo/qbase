/**
 * Account migration rehearsal (docs/specs/account-root.md §6, option 2).
 * Never writes to D1.
 *
 *   npx --yes tsx scripts/accounts-backfill.ts [--db=prod|dev]
 *
 * Reads identity columns only (row ids and person keys; no answer content,
 * no sealed data) through `wrangler d1 execute --remote --json`, loads them
 * into an in-memory SQLite (node:sqlite), and runs exactly the SQL the admin
 * route runs: migration 0076 → preflight → `accounts` → `rewrite` → `rewrite`
 * again (must change nothing) → status (every legacy count 0) → `unrewrite`
 * (must restore every column byte for byte). Prints the report and writes it
 * to scripts/out/ (git-ignored). Exits non-zero if any step misbehaves.
 *
 * Passkeys with no account are minted in JS by the route; the rehearsal
 * mirrors that with the same statements.
 */

import { execFileSync } from 'child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { DatabaseSync } from 'node:sqlite';
import {
  accountsStatements, rewriteStatements, unrewriteStatements, statusQueries, preflightChecks,
  PERSON_KEY_COLUMNS, PERSON_KEY_TEXT_COLUMNS, FID_SOURCE_COLUMNS, UNLINKED_PASSKEYS_SQL, AMBIGUOUS_ACCOUNTS_SQL,
  RANDOM_ACCOUNT_ID_SQL,
} from '../worker/services/accounts/migrationSql';

const args = new Map(process.argv.slice(2).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? 'true']; }));
const which = args.get('db') ?? 'prod';
if (which !== 'prod' && which !== 'dev') throw new Error('--db must be prod or dev');
const DB = which === 'prod' ? 'prod-qbase' : 'dev-qbase';
const CONFIG = which === 'prod' ? 'wrangler.jsonc' : 'wrangler.dev.jsonc';
const ANON_FID = Number(args.get('anon-fid') ?? 514282);

type Row = Record<string, unknown>;
function d1(sql: string): Row[] {
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', DB, '--remote', '--json', '--config', CONFIG, '--command', sql], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 512 * 1024 * 1024,
  });
  return JSON.parse(out.slice(out.indexOf('[')))[0].results as Row[];
}

const tables = d1(`SELECT name FROM sqlite_master WHERE type = 'table'`).map(r => String(r.name));
const has = (t: string) => tables.some(x => x.toLowerCase() === t.toLowerCase());

// Identity columns per table: the row id (for the rewrite log) plus every key column.
const ID_COL: Record<string, string> = { Answers: 'id', queries: 'id', quiz_completions: 'id', polls: 'id', poll_options: 'id', council_summons: 'id', direct_queries: 'id', direct_query_responses: 'id', inquiry_responses: 'id', temporary_answers: 'id', answer_likes: 'id', bartlet_unlocks: 'tx_hash' };
const cols = new Map<string, Set<string>>();
const add = (t: string, c: string) => { if (has(t)) cols.set(t, new Set([...(cols.get(t) ?? []), c])); };
for (const [t, c] of [...PERSON_KEY_COLUMNS, ...PERSON_KEY_TEXT_COLUMNS, ...FID_SOURCE_COLUMNS]) add(t, c);
add('queries', 'coiner_id'); add('queries', 'owner_id'); add('queries', 'coiner_fid');
add('Users', 'quil_address'); add('Users', 'fname');
add('passkey_users', 'address'); add('passkey_users', 'display_name');
for (const t of cols.keys()) if (ID_COL[t]) add(t, ID_COL[t]);

const TEXT_COLS = new Set([
  ...PERSON_KEY_TEXT_COLUMNS.map(([t, c]) => `${t}.${c}`),
  ...Object.entries(ID_COL).map(([t, c]) => `${t}.${c}`),
  'Users.quil_address', 'Users.fname', 'passkey_users.address', 'passkey_users.display_name',
]);
function columnType(t: string, c: string): string {
  if (t === 'Users' && c === 'fid') return 'INTEGER PRIMARY KEY';
  return TEXT_COLS.has(`${t}.${c}`) ? 'TEXT' : 'INTEGER';
}

const mem = new DatabaseSync(':memory:');
const snapshot: Record<string, Row[]> = {};
for (const [t, cs] of cols) {
  const list = [...cs];
  const defs = list.map(c => `${c} ${columnType(t, c)}`);
  mem.exec(`CREATE TABLE ${t} (${defs.join(', ')})`);
  const rows = d1(`SELECT ${list.join(', ')} FROM ${t}`);
  snapshot[t] = rows;
  const ins = mem.prepare(`INSERT INTO ${t} (${list.join(', ')}) VALUES (${list.map(() => '?').join(', ')})`);
  for (const r of rows) ins.run(...list.map(c => r[c] as string | number | null));
}
const memTables = mem.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map(r => String(r.name));
const memHas = (t: string) => memTables.some(x => x.toLowerCase() === t.toLowerCase());
const dumpKeys = () => JSON.stringify([...cols.keys()].sort().map(t => [t, mem.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()]));
const status = () => Object.fromEntries(statusQueries(memHas, ANON_FID).map(q => [q.name, Number((mem.prepare(q.sql).get() as Row).n)]));

const failures: string[] = [];
const now = Date.now();

mem.exec(readFileSync('migrations/0076_accounts.sql', 'utf8'));
const pre = Object.fromEntries(preflightChecks(memHas).map(q => [q.name, Number((mem.prepare(q.sql).get() as Row).n)]));
if (Object.values(pre).some(n => n > 0)) failures.push(`preflight: ${JSON.stringify(pre)}`);

for (const s of accountsStatements(memHas, now)) mem.exec(s);
let minted = 0;
for (const p of mem.prepare(UNLINKED_PASSKEYS_SQL).all() as Array<{ address: string; display_name: string | null }>) {
  const id = Number((mem.prepare(`SELECT ${RANDOM_ACCOUNT_ID_SQL} AS id`).get() as Row).id);
  mem.prepare(`INSERT INTO accounts (id, born_from, legacy_key, created_at) VALUES (?, 'passkey', NULL, ?)`).run(id, now);
  mem.prepare(`INSERT INTO account_credentials (kind, value, account_id, label, created_at) VALUES ('passkey', ?, ?, ?, ?)`).run(p.address, id, p.display_name, now);
  mem.prepare(`INSERT OR IGNORE INTO Users (fid, fname, quil_address) VALUES (?, ?, ?)`).run(id, p.display_name, p.address);
  minted++;
}
const afterAccounts = status();
const withPasskeyProfiles = dumpKeys();

mem.exec('BEGIN');
for (const s of rewriteStatements(memHas, ANON_FID, now)) mem.exec(s);
mem.exec('COMMIT');
const afterRewrite = status();
const rewritten = dumpKeys();
for (const s of rewriteStatements(memHas, ANON_FID, now)) mem.exec(s);
if (dumpKeys() !== rewritten) failures.push('second rewrite changed data (not idempotent)');
for (const [k, v] of Object.entries(afterRewrite)) {
  if (k.endsWith('_legacy_values') && v > 0) failures.push(`after rewrite ${k} = ${v}`);
}
for (const k of ['account_ids_out_of_range', 'credentials_to_missing_account', 'passkeys_without_account']) {
  if ((afterRewrite[k] ?? 0) > 0) failures.push(`after rewrite ${k} = ${afterRewrite[k]}`);
}
const ambiguous = mem.prepare(AMBIGUOUS_ACCOUNTS_SQL).all();

mem.exec('BEGIN');
for (const s of unrewriteStatements(memHas)) mem.exec(s);
mem.exec('COMMIT');
if (dumpKeys() !== withPasskeyProfiles) failures.push('unrewrite did not restore the pre-rewrite state exactly');

const summary = {
  db: DB, generated_at: new Date(now).toISOString(),
  rows_read: Object.fromEntries(Object.entries(snapshot).map(([t, r]) => [t, r.length])),
  preflight: pre, minted_passkey_accounts: minted,
  after_accounts: afterAccounts, after_rewrite: afterRewrite,
  ambiguous_accounts: ambiguous,
  failures,
};
mkdirSync('scripts/out', { recursive: true });
const stem = `scripts/out/accounts-rehearsal-${which}-${new Date(now).toISOString().replace(/[:.]/g, '-')}`;
writeFileSync(`${stem}.json`, JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ ...summary, after_accounts: undefined }, null, 2));
console.log(`report ${stem}.json`);
process.exit(failures.length ? 1 : 0);
