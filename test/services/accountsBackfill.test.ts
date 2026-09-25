/**
 * Account backfill planner (docs/specs/account-root.md §5).
 *
 * The fixture copies prod's identity edge cases (2026-09-25): negative
 * placeholder fids on two passkey Users rows, one of them with a
 * quil_address absent from passkey_users; passkeys linked to a fid; two
 * unlinked passkeys with no Users row; quiz takers who answered but have no
 * Users row. The emitted SQL runs twice against local D1 and must leave every
 * pre-existing table untouched and the new tables identical after run two.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { planBackfill, verificationChecks, type BackfillSnapshot } from '../../worker/services/accounts/backfillPlan';

const NOW = 1_790_000_000_000;
const TABLES = ['Users', 'passkey_users', 'Answers', 'quiz_completions', 'anon_attributions'];

const base = (): BackfillSnapshot => ({
  tables: TABLES,
  users: [
    { fid: 10215, quil_address: 'zQmZoo' },
    { fid: 777, quil_address: null },
    { fid: -1, quil_address: 'zQmOrphanQuil' },
    { fid: -2, quil_address: 'QmTest123' },
  ],
  passkeyUsers: [
    { address: 'zQmZoo', fid: 10215 },
    { address: 'zQmZooPhone', fid: 10215 },
    { address: 'zQmLoneB', fid: null },
    { address: 'zQmLoneA', fid: null },
  ],
  orphanNegativeKeys: [],
  minDataKey: 0,
});

describe('planBackfill', () => {
  it('allocates negative ids only for passkeys with no account, below every existing id', () => {
    const plan = planBackfill(base(), NOW);
    expect(plan.allocations).toEqual([
      { address: 'zQmLoneA', accountId: -3 },
      { address: 'zQmLoneB', accountId: -4 },
    ]);
  });

  it('allocates below existing accounts and the sequence on a re-run, and not at all when already credentialed', () => {
    const snap = { ...base(), existingAccounts: [{ id: -9 }], existingCredentials: [{ kind: 'passkey', value: 'zQmLoneA', account_id: -9 }], existingSeqNext: -10 };
    expect(planBackfill(snap, NOW).allocations).toEqual([{ address: 'zQmLoneB', accountId: -10 }]);
  });

  it('refuses when passkey_users and Users.quil_address disagree about an address', () => {
    const snap = base();
    snap.users.push({ fid: 555, quil_address: 'zQmZooPhone' });
    expect(() => planBackfill(snap, NOW)).toThrow(/passkey_users says fid 10215, Users.quil_address says 555/);
  });

  it('refuses a quil_address held by two Users rows', () => {
    const snap = base();
    snap.users.push({ fid: 556, quil_address: 'zQmZoo' });
    expect(() => planBackfill(snap, NOW)).toThrow(/on several Users rows/);
  });

  it('refuses negative user keys that have no Users row', () => {
    expect(() => planBackfill({ ...base(), orphanNegativeKeys: [-7] }, NOW)).toThrow(/-7/);
  });

  it('refuses when an existing credential points elsewhere', () => {
    const snap = { ...base(), existingAccounts: [], existingCredentials: [{ kind: 'passkey', value: 'zQmZoo', account_id: 1 }], existingSeqNext: null };
    expect(() => planBackfill(snap, NOW)).toThrow(/already credentialed to 1/);
  });

  it('emits no statement that writes to a pre-existing table', () => {
    for (const s of planBackfill(base(), NOW).statements) {
      expect(s).toMatch(/^INSERT (OR IGNORE )?INTO (accounts|account_credentials|account_id_seq) /);
    }
  });
});

describe('emitted SQL against local D1', () => {
  const run = async (sql: string) => env.DB.prepare(sql).run();
  const all = async (sql: string) => (await env.DB.prepare(sql).all()).results as Array<Record<string, unknown>>;
  const dump = async () => JSON.stringify([
    await all('SELECT * FROM accounts ORDER BY id'),
    await all('SELECT * FROM account_credentials ORDER BY kind, value'),
    await all('SELECT * FROM account_id_seq'),
  ]);
  const counts = async () => JSON.stringify(await Promise.all(TABLES.map(t => all(`SELECT COUNT(*) AS n FROM ${t}`))));

  beforeAll(async () => {
    await env.DB.batch([
      env.DB.prepare('DROP TABLE IF EXISTS Users'), env.DB.prepare('DROP TABLE IF EXISTS passkey_users'),
      env.DB.prepare('DROP TABLE IF EXISTS Answers'), env.DB.prepare('DROP TABLE IF EXISTS quiz_completions'),
      env.DB.prepare('DROP TABLE IF EXISTS anon_attributions'),
      env.DB.prepare('DROP TABLE IF EXISTS accounts'), env.DB.prepare('DROP TABLE IF EXISTS account_credentials'), env.DB.prepare('DROP TABLE IF EXISTS account_id_seq'),
    ]);
    await env.DB.batch([
      env.DB.prepare('CREATE TABLE Users (fid INTEGER PRIMARY KEY, fname TEXT, quil_address TEXT)'),
      env.DB.prepare('CREATE TABLE passkey_users (address TEXT PRIMARY KEY, fid INTEGER, display_name TEXT)'),
      env.DB.prepare('CREATE TABLE Answers (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL)'),
      env.DB.prepare('CREATE TABLE quiz_completions (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL)'),
      env.DB.prepare('CREATE TABLE anon_attributions (id TEXT PRIMARY KEY)'),
    ]);
    const snap = base();
    for (const u of snap.users) await env.DB.prepare('INSERT INTO Users (fid, fname, quil_address) VALUES (?, ?, ?)').bind(u.fid, `u${u.fid}`, u.quil_address).run();
    for (const p of snap.passkeyUsers) await env.DB.prepare('INSERT INTO passkey_users (address, fid, display_name) VALUES (?, ?, ?)').bind(p.address, p.fid, `pk-${p.address}`).run();
    // 900 answered through a quiz snap and never got a Users row; 10215 answered too.
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO Answers (id, user_id) VALUES ('a1', 900), ('a2', 900), ('a3', 10215)`),
      env.DB.prepare(`INSERT INTO quiz_completions (id, user_id) VALUES ('c1', 900)`),
    ]);
    for (const stmt of [
      `CREATE TABLE accounts (id INTEGER PRIMARY KEY, born_from TEXT NOT NULL, created_at INTEGER NOT NULL)`,
      `CREATE TABLE account_credentials (kind TEXT NOT NULL, value TEXT NOT NULL, account_id INTEGER NOT NULL, label TEXT, created_at INTEGER NOT NULL, last_used_at INTEGER, PRIMARY KEY (kind, value))`,
      `CREATE TABLE account_id_seq (id INTEGER PRIMARY KEY CHECK (id = 1), next INTEGER NOT NULL)`,
    ]) await run(stmt);
  });

  it('fills the accounts, is idempotent, and touches nothing else', async () => {
    const plan = planBackfill(base(), NOW);
    const before = await counts();
    for (const s of plan.statements) await run(s);
    const first = await dump();
    for (const s of plan.statements) await run(s);
    expect(await dump()).toBe(first);
    expect(await counts()).toBe(before);

    const accounts = await all('SELECT id, born_from FROM accounts ORDER BY id');
    expect(accounts).toEqual([
      { id: -4, born_from: 'passkey' }, { id: -3, born_from: 'passkey' },
      { id: -2, born_from: 'legacy' }, { id: -1, born_from: 'legacy' },
      { id: 777, born_from: 'farcaster' }, { id: 900, born_from: 'farcaster' }, { id: 10215, born_from: 'farcaster' },
    ]);
    const creds = await all('SELECT kind, value, account_id FROM account_credentials ORDER BY kind, value');
    expect(creds).toEqual([
      { kind: 'farcaster', value: '10215', account_id: 10215 },
      { kind: 'farcaster', value: '777', account_id: 777 },
      { kind: 'farcaster', value: '900', account_id: 900 },
      { kind: 'passkey', value: 'QmTest123', account_id: -2 },
      { kind: 'passkey', value: 'zQmLoneA', account_id: -3 },
      { kind: 'passkey', value: 'zQmLoneB', account_id: -4 },
      { kind: 'passkey', value: 'zQmOrphanQuil', account_id: -1 },
      { kind: 'passkey', value: 'zQmZoo', account_id: 10215 },
      { kind: 'passkey', value: 'zQmZooPhone', account_id: 10215 },
    ]);
    expect(await all('SELECT next FROM account_id_seq')).toEqual([{ next: -5 }]);

    const has = (t: string) => TABLES.includes(t);
    for (const c of verificationChecks(has)) {
      const n = Number((await all(c.sql))[0].n);
      expect({ check: c.name, n }).toEqual({ check: c.name, n: c.expect });
    }
  });
});
