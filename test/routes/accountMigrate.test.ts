/**
 * The fid → account cutover (docs/specs/account-root.md §6, option 2), end to
 * end on local D1 with real sealing under throwaway keys.
 *
 * The fixture copies prod's identity edge cases (2026-09-25): negative
 * placeholder fids on two passkey Users rows; passkeys linked to a fid; an
 * unlinked passkey with no Users row; quiz takers with answers but no Users
 * row; the anon placeholders (514282, legacy 3) on Answers; a legacy
 * internal id (1) where fids are expected; questions whose coiner_id is a
 * legacy internal id (2, 3) next to the true coiner_fid; text keys in follows
 * and answer_likes; a Private answer sealed in the object store, a sealed
 * completion, and an anon attribution.
 *
 * Forward: accounts → rewrite → rewrite again (no-op) → reowner ×2 → retag,
 * with every read path checked. Backward: retag/reowner reversed, unrewrite —
 * and every table must equal its pre-rewrite state exactly.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { env } from 'cloudflare:test';
import migration from '../../migrations/0076_accounts.sql?raw';
import { handleAdminAccountMigrate } from '../../worker/routes/admin-account-migrate';
import { setObjectStoreForTests, SecretStore, type ObjectStore } from '../../worker/services/secret/SecretStore';
import { completionCtx, readCompletionAnswers } from '../../worker/routes/quiz-completions';
import { openSealedAnswer } from '../../worker/handlers/answers/shared';
import { attributionStatement, isAuthor } from '../../worker/services/AnonAttributionService';
import { _resetAccountCaches } from '../../worker/services/accounts/AccountService';
import { ACCOUNT_ID_MIN } from '../../worker/services/accounts/migrationSql';

class MemStore implements ObjectStore {
  objects = new Map<string, string>();
  async put(key: string, data: string) { this.objects.set(key, data); return { success: true, key }; }
  async get(key: string) {
    const t = this.objects.get(key);
    return t === undefined ? null : { data: new TextEncoder().encode(t).buffer as ArrayBuffer };
  }
  async delete(key: string) { return this.objects.delete(key); }
}

const b64 = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const ADMIN = 'admin-secret';
const ANON = 514282;
const testEnv = { DB: env.DB, KV_USER_POINTS: env.KV_USER_POINTS, KV_USER_PROFILES: env.KV_USER_PROFILES, ANSWER_KEKS: b64(), ANON_TAG_KEY: b64(), ANON_FID: String(ANON), QBASE_ADMIN_SECRET: ADMIN };
const store = new MemStore();

async function call(body: Record<string, unknown>) {
  const res = await handleAdminAccountMigrate(new Request('http://x/api/admin/account-migrate', {
    method: 'POST', headers: { 'X-Admin-Secret': ADMIN, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }), testEnv);
  return { status: res!.status, body: await res!.json() as Record<string, any> };
}
const all = async (sql: string, ...b: unknown[]) => ((await env.DB.prepare(sql).bind(...b).all()).results ?? []) as Array<Record<string, any>>;
const one = async (sql: string, ...b: unknown[]) => (await all(sql, ...b))[0];
const acct = async (legacyKey: number) => Number((await one('SELECT id FROM accounts WHERE legacy_key = ?', legacyKey))?.id);

const PERSON_TABLES = ['Users', 'passkey_users', 'Answers', 'quiz_completions', 'queries', 'follows', 'answer_likes', 'bartlet_airdrops', 'anon_attributions'];
const dump = async () => JSON.stringify(await Promise.all(PERSON_TABLES.map(t => all(`SELECT * FROM ${t} ORDER BY rowid`))));

describe('account migration', () => {
  let preRewrite = '';

  beforeAll(async () => {
    setObjectStoreForTests(store);
    _resetAccountCaches();
    const drop = [...PERSON_TABLES, 'accounts', 'account_credentials', 'account_migration', 'account_rewrite_log'];
    await env.DB.batch(drop.map(t => env.DB.prepare(`DROP TABLE IF EXISTS ${t}`)));
    await env.DB.batch([
      env.DB.prepare(`CREATE TABLE Users (fid INTEGER PRIMARY KEY, fname TEXT, display_name TEXT, profile_source TEXT, quil_address TEXT)`),
      env.DB.prepare(`CREATE TABLE passkey_users (address TEXT PRIMARY KEY, fid INTEGER, display_name TEXT)`),
      env.DB.prepare(`CREATE TABLE Answers (id TEXT PRIMARY KEY, q_id TEXT NOT NULL, user_id INTEGER NOT NULL, value TEXT, audience TEXT, storage_ref TEXT, created_at TEXT)`),
      env.DB.prepare(`CREATE TABLE quiz_completions (id TEXT PRIMARY KEY, quiz_id TEXT, user_id INTEGER NOT NULL, visibility TEXT, answers_encrypted TEXT)`),
      env.DB.prepare(`CREATE TABLE queries (id TEXT PRIMARY KEY, coiner_id INTEGER, owner_id INTEGER, coiner_fid INTEGER)`),
      env.DB.prepare(`CREATE TABLE follows (follower_id TEXT NOT NULL, followee_id TEXT NOT NULL, PRIMARY KEY (follower_id, followee_id))`),
      env.DB.prepare(`CREATE TABLE answer_likes (id TEXT PRIMARY KEY, answer_id TEXT, user_fid INTEGER, user_id TEXT)`),
      env.DB.prepare(`CREATE TABLE bartlet_airdrops (fid INTEGER PRIMARY KEY, to_address TEXT)`),
      env.DB.prepare(`CREATE TABLE anon_attributions (id TEXT PRIMARY KEY, public_id TEXT NOT NULL UNIQUE, author_id INTEGER, author_tag TEXT, author_ct TEXT, type TEXT NOT NULL, created_at TEXT NOT NULL)`),
    ]);
    for (const stmt of migration.replace(/--.*$/gm, '').split(';').map(s => s.trim()).filter(Boolean)) await env.DB.prepare(stmt).run();

    await env.DB.batch([
      env.DB.prepare(`INSERT INTO Users (fid, fname, quil_address) VALUES (10215, 'zoo', 'zQmZoo'), (777, 'seven', NULL), (1, 'legacy-one', NULL), (-1, 'qbase-x', 'zQmOrphan'), (-2, 'passkey_user', 'QmTest123')`),
      env.DB.prepare(`INSERT INTO passkey_users (address, fid, display_name) VALUES ('zQmZoo', 10215, 'zoo'), ('zQmZooPhone', 10215, 'zoo'), ('zQmLone', NULL, 'lone')`),
      env.DB.prepare(`INSERT INTO Answers (id, q_id, user_id, value, audience, storage_ref) VALUES
        ('a1', 'q1', 10215, 'yes', 'Public', NULL),
        ('a2', 'q1', 900, '[private]', 'Private', 'answers/private/a2'),
        ('a3', 'q1', ${ANON}, 'anon', 'Anon', NULL),
        ('a4', 'q1', 3, 'old anon', 'Anon', NULL),
        ('a5', 'q1', 1, 'legacy', 'Public', NULL)`),
      env.DB.prepare(`INSERT INTO queries (id, coiner_id, owner_id, coiner_fid) VALUES ('q1', 3, 3, ${ANON}), ('q2', 2, 2, 10215), ('q3', 10215, 10215, 10215)`),
      env.DB.prepare(`INSERT INTO follows (follower_id, followee_id) VALUES ('777', '10215')`),
      env.DB.prepare(`INSERT INTO answer_likes (id, answer_id, user_fid, user_id) VALUES ('l1', 'a1', 777, '777'), ('l2', 'a1', 10215, 'zQmZoo')`),
      env.DB.prepare(`INSERT INTO bartlet_airdrops (fid, to_address) VALUES (777, '0xabc')`),
    ]);
    await SecretStore.putJSON(testEnv, 'answers/private/a2', { value: 'secret value' }, { tier: 'Private', owner: 900 });
    const sealed = await SecretStore.sealForD1(testEnv, JSON.stringify([{ q: 1, v: 'x' }]), completionCtx('c1', 'private', 900));
    await env.DB.prepare(`INSERT INTO quiz_completions (id, quiz_id, user_id, visibility, answers_encrypted) VALUES ('c1', 'values', 900, 'private', ?)`).bind(sealed).run();
    await (await attributionStatement(testEnv, { public_id: 'a3', fid: 10215, type: 'answer', scope_id: 'q1' })).run();
  });
  afterAll(() => setObjectStoreForTests(null));

  it('refuses without the admin secret', async () => {
    const res = await handleAdminAccountMigrate(new Request('http://x/api/admin/account-migrate', { method: 'POST', body: '{}' }), testEnv);
    expect(res!.status).toBe(403);
  });

  it('accounts: every person key gets an account; ambiguous keys get no farcaster credential', async () => {
    expect((await call({ phase: 'status' })).body.state).toBe('none');
    const dry = await call({ phase: 'accounts', dryRun: true });
    expect(dry.status).toBe(200);
    expect(await one('SELECT COUNT(*) AS n FROM accounts')).toEqual({ n: 0 });

    const r = await call({ phase: 'accounts' });
    expect(r.status).toBe(200);
    expect(r.body.minted_passkey_accounts).toBe(1);

    for (const k of [10215, 777, 900, ANON, 1, -1, -2]) expect(await acct(k)).toBeGreaterThanOrEqual(ACCOUNT_ID_MIN);
    expect(await one('SELECT COUNT(*) AS n FROM accounts WHERE legacy_key IN (3, 2)')).toEqual({ n: 0 });
    expect(await one(`SELECT born_from FROM accounts WHERE legacy_key = 1`)).toEqual({ born_from: 'legacy' });
    expect(await one(`SELECT COUNT(*) AS n FROM account_credentials WHERE kind = 'farcaster' AND value IN ('1', '-1', '-2')`)).toEqual({ n: 0 });
    expect(await one(`SELECT account_id FROM account_credentials WHERE kind = 'farcaster' AND value = '10215'`)).toEqual({ account_id: await acct(10215) });
    expect(await all(`SELECT value FROM account_credentials WHERE kind = 'passkey' AND account_id = ? ORDER BY value`, await acct(10215))).toEqual([{ value: 'zQmZoo' }, { value: 'zQmZooPhone' }]);
    expect(await one(`SELECT account_id FROM account_credentials WHERE kind = 'passkey' AND value = 'zQmOrphan'`)).toEqual({ account_id: await acct(-1) });
    const lone = await one(`SELECT a.born_from, a.legacy_key FROM account_credentials c JOIN accounts a ON a.id = c.account_id WHERE c.kind = 'passkey' AND c.value = 'zQmLone'`);
    expect(lone).toEqual({ born_from: 'passkey', legacy_key: null });

    // idempotent
    const before = await one('SELECT COUNT(*) AS n FROM accounts');
    await call({ phase: 'accounts' });
    expect(await one('SELECT COUNT(*) AS n FROM accounts')).toEqual(before);
    const st = await call({ phase: 'status' });
    expect(st.body.state).toBe('accounts');
    expect(st.body.ambiguous_accounts.map((a: { legacy_key: number }) => a.legacy_key)).toEqual([-2, -1, 1]);
    preRewrite = await dump();
  });

  it('rewrite: person keys become account ids in one step; sentinels and farcaster facts stay', async () => {
    const dry = await call({ phase: 'rewrite', dryRun: true });
    expect(dry.body.legacy_values['Answers.user_id_legacy_values']).toBe(3); // a1, a2, a5
    expect(await dump()).toBe(preRewrite);

    const r = await call({ phase: 'rewrite' });
    expect(r.status).toBe(200);
    const zoo = await acct(10215);
    expect(await all('SELECT id, user_id FROM Answers ORDER BY id')).toEqual([
      { id: 'a1', user_id: zoo }, { id: 'a2', user_id: await acct(900) }, { id: 'a3', user_id: ANON }, { id: 'a4', user_id: 3 }, { id: 'a5', user_id: await acct(1) },
    ]);
    expect(await all('SELECT id, coiner_id, owner_id, coiner_fid FROM queries ORDER BY id')).toEqual([
      { id: 'q1', coiner_id: await acct(ANON), owner_id: await acct(ANON), coiner_fid: ANON },
      { id: 'q2', coiner_id: zoo, owner_id: zoo, coiner_fid: 10215 },
      { id: 'q3', coiner_id: zoo, owner_id: zoo, coiner_fid: 10215 },
    ]);
    expect(await all('SELECT follower_id, followee_id FROM follows')).toEqual([{ follower_id: String(await acct(777)), followee_id: String(zoo) }]);
    expect(await all('SELECT id, user_fid, user_id FROM answer_likes ORDER BY id')).toEqual([
      { id: 'l1', user_fid: await acct(777), user_id: String(await acct(777)) },
      { id: 'l2', user_fid: zoo, user_id: String(zoo) },
    ]);
    expect(await all('SELECT fid FROM Users WHERE fid < ? ORDER BY fid', ACCOUNT_ID_MIN)).toEqual([]);
    expect(await one('SELECT fid FROM bartlet_airdrops')).toEqual({ fid: await acct(777) });
    expect(await one('SELECT fid FROM passkey_users WHERE address = ?', 'zQmZoo')).toEqual({ fid: 10215 }); // a Farcaster fact

    const st = await call({ phase: 'status' });
    expect(st.body.state).toBe('rewritten');
    expect(st.body.legacy_values_left).toEqual({});

    const snapshot = await dump();
    await call({ phase: 'rewrite' });
    expect(await dump()).toBe(snapshot);
  });

  it('reowner: sealed answers and completions follow the row to the account id', async () => {
    const owner = await acct(900);
    await expect(SecretStore.getJSON(testEnv, 'answers/private/a2', { tier: 'Private', owner })).rejects.toThrow(/context mismatch/);
    // …but the app's readers fall back to the legacy key in the window before reowner.
    expect(await openSealedAnswer(testEnv, await one('SELECT storage_ref, audience, user_id FROM Answers WHERE id = ?', 'a2'))).toEqual({ value: 'secret value' });
    expect(await readCompletionAnswers(testEnv, await one('SELECT * FROM quiz_completions WHERE id = ?', 'c1') as never)).toEqual([{ q: 1, v: 'x' }]);

    const dry = await call({ phase: 'reowner', target: 'answers', dryRun: true });
    expect(dry.body.changed).toBe(1);
    const r = await call({ phase: 'reowner', target: 'answers' });
    expect(r.body).toMatchObject({ changed: 1, errors: [], done: true });
    expect(await SecretStore.getJSON(testEnv, 'answers/private/a2', { tier: 'Private', owner })).toEqual({ value: 'secret value' });
    expect((await call({ phase: 'reowner', target: 'answers' })).body).toMatchObject({ changed: 0, already: 1 });

    const c = await call({ phase: 'reowner', target: 'completions' });
    expect(c.body).toMatchObject({ changed: 1, errors: [] });
    const row = await one('SELECT answers_encrypted FROM quiz_completions WHERE id = ?', 'c1');
    expect(await SecretStore.openFromD1(testEnv, row.answers_encrypted, completionCtx('c1', 'private', owner))).toEqual([{ q: 1, v: 'x' }]);
    expect(JSON.parse(row.answers_encrypted).ctx).toBe(completionCtx('c1', 'private', owner));
  });

  it('retag: anon ownership follows the account', async () => {
    const zoo = await acct(10215);
    expect(await isAuthor(testEnv, 'a3', 10215, 'q1')).toBe(true);
    const r = await call({ phase: 'retag' });
    expect(r.body).toMatchObject({ changed: 1, errors: [] });
    expect(await isAuthor(testEnv, 'a3', zoo, 'q1')).toBe(true);
    expect(await isAuthor(testEnv, 'a3', 10215, 'q1')).toBe(false);
    expect((await call({ phase: 'retag' })).body).toMatchObject({ changed: 0, already: 1 });
  });

  it('kv: points and settings are copied to the account key, never moved', async () => {
    const zoo = await acct(10215);
    await env.KV_USER_POINTS.put('10215', '{"balance":42}');
    await env.KV_USER_POINTS.put('555555', '{"balance":1}');          // no account: reported, untouched
    await env.KV_USER_PROFILES.put('settings:10215', '{"theme":"dark"}');
    await env.KV_USER_POINTS.put(String(await acct(777)), '{"balance":9}'); // written by new code already: kept

    const dry = await call({ phase: 'kv', target: 'points', dryRun: true });
    expect(dry.body).toMatchObject({ copied: 1, unmapped: 1, done: true });
    expect(await env.KV_USER_POINTS.get(String(zoo))).toBeNull();

    expect((await call({ phase: 'kv', target: 'points' })).body).toMatchObject({ copied: 1, unmapped: 1 });
    expect(await env.KV_USER_POINTS.get(String(zoo))).toBe('{"balance":42}');
    expect(await env.KV_USER_POINTS.get('10215')).toBe('{"balance":42}');
    expect((await call({ phase: 'kv', target: 'settings' })).body).toMatchObject({ copied: 1 });
    expect(await env.KV_USER_PROFILES.get(`settings:${zoo}`)).toBe('{"theme":"dark"}');
    expect((await call({ phase: 'kv', target: 'points' })).body).toMatchObject({ copied: 0, already: 1 });
  });

  it('attach: settles an ambiguous legacy account', async () => {
    const legacy = await acct(1);
    const r = await call({ phase: 'attach', accountId: legacy, fid: 4242 });
    expect(r.status).toBe(200);
    expect(await one(`SELECT account_id FROM account_credentials WHERE kind = 'farcaster' AND value = '4242'`)).toEqual({ account_id: legacy });
    expect((await call({ phase: 'attach', accountId: await acct(10215), fid: 4243 })).body.error).toBe('not_a_legacy_account');
    await env.DB.prepare(`DELETE FROM account_credentials WHERE kind = 'farcaster' AND value = '4242'`).run();
  });

  it('reverse: every sweep and the rewrite undo exactly', async () => {
    expect((await call({ phase: 'retag', reverse: true })).body).toMatchObject({ changed: 1, errors: [] });
    expect((await call({ phase: 'reowner', target: 'answers', reverse: true })).body).toMatchObject({ changed: 1, errors: [] });
    expect((await call({ phase: 'reowner', target: 'completions', reverse: true })).body).toMatchObject({ changed: 1, errors: [] });
    const u = await call({ phase: 'unrewrite' });
    expect(u.status).toBe(200);
    expect(await isAuthor(testEnv, 'a3', 10215, 'q1')).toBe(true);
    expect(await SecretStore.getJSON(testEnv, 'answers/private/a2', { tier: 'Private', owner: 900 })).toEqual({ value: 'secret value' });

    // Byte-for-byte, except the envelopes and tags that were re-sealed (fresh IVs): compare those by meaning.
    const strip = (s: string) => JSON.parse(s).map((rows: Array<Record<string, unknown>>) => rows.map(r => ({ ...r, answers_encrypted: r.answers_encrypted ? 'sealed' : r.answers_encrypted, author_ct: r.author_ct ? 'sealed' : r.author_ct })));
    expect(strip(await dump())).toEqual(strip(preRewrite));
    expect((await call({ phase: 'status' })).body.state).toBe('accounts');
  });
});
