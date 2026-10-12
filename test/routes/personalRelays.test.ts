/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Relayed answers (docs/specs/personal-mcp.md §3.3, migration 0082):
 * an agent records what the owner told it with record_answer; the answer is
 * Secret and reads as provenance 'relayed' until the owner confirms, edits or
 * deletes it at /api/me/inbox.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { env } from 'cloudflare:test';
import grantsMigration from '../../migrations/0079_grants.sql?raw';
import copyV2 from '../../migrations/0080_mcp_key_copy_v2.sql?raw';
import asksMigration from '../../migrations/0081_asks.sql?raw';
import relaysMigration from '../../migrations/0082_relays.sql?raw';
import { handleMcpRoute } from '../../worker/routes/mcp';
import { handleMeGrantsRoutes } from '../../worker/routes/me-grants';
import { handleMeInboxRoutes } from '../../worker/routes/me-inbox';
import { handleUpdateAnswer } from '../../worker/handlers/answers/mutate';
import { setObjectStoreForTests, type ObjectStore } from '../../worker/services/secret/SecretStore';

class MemStore implements ObjectStore {
  objects = new Map<string, string>();
  async put(key: string, data: string) { this.objects.set(key, data); return { success: true, key }; }
  async get(key: string) { const t = this.objects.get(key); return t === undefined ? null : { data: new TextEncoder().encode(t).buffer as ArrayBuffer }; }
  async delete(key: string) { return this.objects.delete(key); }
}
const b64 = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
// An account id (≥ 2^40) with no linked Farcaster: answering never needs a Farcaster profile.
const ME = 2 ** 40 + 47, ANON = 514282, SESSION = 'personal-relays-session';
const Q_MC = '55555555-5555-4555-8555-555555555555';
const Q_TEXT = '66666666-6666-4666-8666-666666666666';
const Q_PRED = '77777777-7777-4777-8777-777777777777';
const testEnv = {
  ...env,
  ANSWER_KEKS: b64(), ANON_TAG_KEY: b64(), ANON_FID: String(ANON), OPENROUTER_API_KEY: 'test-key',
  ANSWER_CAST_QUEUE: { send: async () => {} },
  AI: { run: async (_m: string, { text }: { text: string[] | string }) => ({ data: [text ?? 'x'].flat().map(() => [0.1, 0.2, 0.3]) }) },
  AINDEX: { upsert: async () => ({ mutationId: 'm', ids: [] }), insert: async () => ({ mutationId: 'm', ids: [] }), deleteByIds: async () => ({ mutationId: 'm' }) },
};

async function owner(handler: typeof handleMeInboxRoutes, method: string, path: string, body?: unknown, token = SESSION) {
  const res = await handler(new Request(`http://x${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), testEnv);
  return { status: res!.status, body: await res!.json() as Record<string, any> };
}
const inbox = (method: string, path: string, body?: unknown, token?: string) => owner(handleMeInboxRoutes, method, path, body, token);

let rpcId = 0;
async function call(key: string, name: string, args: object = {}) {
  const res = await handleMcpRoute(new Request('http://x/mcp', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }),
  }), testEnv);
  return ((await res!.json()) as any).result;
}

let secretKey = '', publicKey = '', derivedKey = '';

describe('relayed answers: record_answer and the inbox', () => {
  beforeAll(async () => {
    setObjectStoreForTests(new MemStore());
    for (const stmt of `${grantsMigration}\n${copyV2}\n${asksMigration}\n${relaysMigration}`.split(/;\s*$/m).map((s) => s.trim()).filter(Boolean)) {
      await env.DB.prepare(stmt).run();
    }
    for (const sql of [
      `CREATE TABLE IF NOT EXISTS queries (id TEXT PRIMARY KEY, stem TEXT NOT NULL, type TEXT NOT NULL, a_options TEXT, scale_config TEXT, date_config TEXT,
         created_at TEXT, coiner_id INTEGER, owner_id INTEGER, coiner_fname TEXT, coiner_fid INTEGER, tags TEXT, reqs TEXT, assets TEXT, parent TEXT,
         pub_answers INTEGER DEFAULT 0, priv_answers INTEGER DEFAULT 0, comments INTEGER DEFAULT 0, taxonomy TEXT, channel_id TEXT, casthash TEXT, token_id TEXT, cost INTEGER DEFAULT 0, template BOOLEAN DEFAULT FALSE)`,
      `CREATE TABLE IF NOT EXISTS farcaster_casts (id TEXT, entity_type TEXT, entity_id TEXT, cast_hash TEXT, cast_url TEXT, caster_fid INTEGER, cached_likes_count INTEGER, cached_recasts_count INTEGER, cached_replies_count INTEGER, stats_synced_at INTEGER)`,
      `CREATE TABLE IF NOT EXISTS question_meta (question_id TEXT PRIMARY KEY, forked_from TEXT)`,
      `CREATE TABLE IF NOT EXISTS polls (id TEXT PRIMARY KEY, question_id TEXT NOT NULL, closes_at TEXT NOT NULL, eligibility_gate TEXT, options_config TEXT, author_fid INTEGER, cast_hash TEXT, created_at TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'measure', channel_id TEXT)`,
      `CREATE TABLE IF NOT EXISTS Answers (id TEXT PRIMARY KEY, q_id TEXT NOT NULL, user_id INTEGER, value TEXT, answer_type_id TEXT, answer_data TEXT, audience TEXT, created_at TEXT, primary_type TEXT, reasoning TEXT, topics TEXT, storage_ref TEXT, poll_id TEXT, quiz_completion_id TEXT)`,
      `CREATE TABLE IF NOT EXISTS answer_meta (id TEXT PRIMARY KEY, question_id TEXT, reply_cast_hash TEXT, replied_to_hash TEXT, responder_fid INTEGER, privacy_tier TEXT, storage_ref TEXT, primary_value TEXT, answer_index INTEGER, pending INTEGER, created_at INTEGER)`,
      `CREATE TABLE IF NOT EXISTS Users (fid INTEGER PRIMARY KEY, fname TEXT, display_name TEXT, pfp_url TEXT, profile_source TEXT)`,
      `CREATE TABLE IF NOT EXISTS anon_attributions (id TEXT PRIMARY KEY, public_id TEXT NOT NULL UNIQUE, author_id INTEGER, author_tag TEXT, author_ct TEXT, type TEXT NOT NULL, created_at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS quiz_completions (id TEXT PRIMARY KEY, quiz_id TEXT, user_id INTEGER, completed_at INTEGER, scores TEXT, result_category TEXT, visibility TEXT, created_at INTEGER)`,
      `INSERT OR IGNORE INTO Users (fid, fname) VALUES (${ME}, 'me')`,
      `CREATE TABLE IF NOT EXISTS account_credentials (account_id INTEGER, kind TEXT, value TEXT)`,
      `CREATE TABLE IF NOT EXISTS account_migration (id INTEGER PRIMARY KEY, state TEXT, rewritten_at INTEGER)`,
      `INSERT OR IGNORE INTO account_migration (id, state, rewritten_at) VALUES (1, 'rewritten', 1)`,
      `INSERT OR IGNORE INTO queries (id, stem, type, a_options, created_at) VALUES
         ('${Q_MC}', 'Would you move for a job?', 'mc', '["yes","no"]', '2026-09-01'),
         ('${Q_TEXT}', 'What makes a city livable?', 'text', NULL, '2026-09-01')`,
      `INSERT OR IGNORE INTO queries (id, stem, type, created_at, taxonomy) VALUES
         ('${Q_PRED}', 'Will it rain in Tokyo tomorrow?', 'text', '2026-09-01', '{"primary_type":"predictive"}')`,
    ]) await env.DB.prepare(sql).run();
    await env.KV_USER_PROFILES.put(`session:${SESSION}`, JSON.stringify({ accountId: ME, expiresAt: Date.now() + 3_600_000 }));

    secretKey = (await owner(handleMeGrantsRoutes, 'POST', '/api/me/grants', { label: 'claude code', ceiling: 'Secret' })).body.key;
    publicKey = (await owner(handleMeGrantsRoutes, 'POST', '/api/me/grants', { label: 'public only' })).body.key;
    derivedKey = (await owner(handleMeGrantsRoutes, 'POST', '/api/me/grants', { label: 'derived', ceiling: 'Secret', disclosure: 'derived' })).body.key;
  });
  afterAll(() => setObjectStoreForTests(null));

  const relayIds = async () => ((await env.DB.prepare('SELECT answer_id FROM relays').all()).results as any[]).map((r) => r.answer_id);
  const history = async (key: string, qid: string) => (await call(key, 'get_answer_history', { question_id: qid })).structuredContent.answers;

  it('needs a raw key that reads Secret, and never writes Anon or Public', async () => {
    for (const key of [publicKey, derivedKey]) {
      const r = await call(key, 'record_answer', { question_id: Q_MC, answer: 'yes' });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toMatch(/Secret/);
      // A dead end names the route that works: ask_owner on an existing public question.
      expect(r.content[0].text).toMatch(/ask_owner with its question_id/);
    }
    for (const audience of ['Anon', 'Public']) {
      const r = await call(secretKey, 'record_answer', { question_id: Q_MC, answer: 'yes', audience });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toMatch(/always Secret/);
    }
    expect(await relayIds()).toEqual([]);
  });

  it('refuses predictions and answers that don\'t fit the question', async () => {
    expect((await call(secretKey, 'record_answer', { question_id: Q_PRED, answer: 'yes' })).content[0].text).toMatch(/prediction/);
    expect((await call(secretKey, 'record_answer', { question_id: Q_MC, answer: 'maybe' })).content[0].text).toMatch(/options/);
    expect(await relayIds()).toEqual([]);
  });

  it('records a public question\'s answer as a sealed Private row, marked relayed everywhere it is read', async () => {
    const r = await call(secretKey, 'record_answer', { question_id: Q_TEXT, answer: 'trains every five minutes', reasoning: 'I hate driving' });
    expect(r.isError).toBe(false);
    expect(r.structuredContent).toMatchObject({ ok: true, tier: 'Secret', provenance: 'relayed', owner_only: false, question_id: Q_TEXT, url: 'http://x/me/inbox#relays' });
    const row = await env.DB.prepare('SELECT * FROM Answers WHERE id = ?').bind(r.structuredContent.answer_id).first() as any;
    expect(row).toMatchObject({ audience: 'Private', value: '[encrypted]', user_id: ME, reasoning: null });
    expect(await relayIds()).toEqual([r.structuredContent.answer_id]);

    expect((await history(secretKey, Q_TEXT))[0]).toMatchObject({ answer: 'trains every five minutes', provenance: 'relayed', tier: 'Secret' });
    const listed = (await call(secretKey, 'list_my_answers')).structuredContent.answers.find((a: any) => a.question_id === Q_TEXT);
    expect(listed).toMatchObject({ provenance: 'relayed', reasoning: 'I hate driving' });
  });

  it('a new stem becomes an owner-only question; the inbox lists both relays, opened, and counts them', async () => {
    const r = await call(secretKey, 'record_answer', { stem: 'How far would you commute?', type: 'scale', scale: { min: 1, max: 5 }, answer: 2 });
    expect(r.isError).toBe(false);
    expect(r.structuredContent).toMatchObject({ owner_only: true, reused: false });
    expect(r.structuredContent.question_id).toMatch(/^oq_/);
    expect(await env.DB.prepare("SELECT id FROM queries WHERE stem LIKE '%commute%'").first()).toBeNull();

    const box = (await inbox('GET', '/api/me/inbox')).body;
    expect(box.relays.map((x: any) => [x.question.stem, x.answer, x.agent])).toEqual([
      ['How far would you commute?', '2', 'claude code'],
      ['What makes a city livable?', 'trains every five minutes', 'claude code'],
    ]);
    expect((await inbox('GET', '/api/me/inbox?count=1')).body).toMatchObject({ pending: 2, relays: 2 });
  });

  it('confirming drops the mark; an edit is saved and confirmed', async () => {
    const box = (await inbox('GET', '/api/me/inbox')).body;
    const [scale, text] = box.relays;
    expect((await inbox('POST', `/api/me/inbox/relays/${text.answer_id}/confirm`, {})).body).toMatchObject({ ok: true, audience: 'Secret' });
    expect((await history(secretKey, Q_TEXT))[0]).toMatchObject({ answer: 'trains every five minutes', provenance: 'stated' });

    expect((await inbox('POST', `/api/me/inbox/relays/${scale.answer_id}/confirm`, { answer: 3 })).body.ok).toBe(true);
    expect((await history(secretKey, scale.question.id))[0]).toMatchObject({ answer: '3', provenance: 'stated' });
    expect(await relayIds()).toEqual([]);
  });

  it('confirming as Anon writes a fresh Anon row with no trace of the key, and deletes the relayed one', async () => {
    const r = await call(secretKey, 'record_answer', { question_id: Q_MC, answer: 'no' });
    const relayed = r.structuredContent.answer_id;
    const grantId = (await env.DB.prepare('SELECT grant_id FROM relays WHERE answer_id = ?').bind(relayed).first() as any).grant_id;

    // Not in place from the answers page: that would keep the time the key's write was logged.
    const put = await handleUpdateAnswer(new Request('http://x/api/answers/' + relayed, {
      method: 'PUT', body: JSON.stringify({ value: 'no', audience: 'Anon', answer_type_id: 2 }),
    }), testEnv, relayed, ME);
    expect(put.status).toBe(409);

    const res = (await inbox('POST', `/api/me/inbox/relays/${relayed}/confirm`, { audience: 'Anon' })).body;
    expect(res).toMatchObject({ ok: true, audience: 'Anon' });
    expect(res.answer_id).not.toBe(relayed);
    expect(await env.DB.prepare('SELECT id FROM Answers WHERE id = ?').bind(relayed).first()).toBeNull();
    const anon = await env.DB.prepare('SELECT * FROM Answers WHERE id = ?').bind(res.answer_id).first() as any;
    expect(anon).toMatchObject({ audience: 'Anon', value: 'no', user_id: ANON });
    const trace = JSON.stringify([anon, ...(await env.DB.prepare('SELECT * FROM anon_attributions').all()).results]);
    expect(trace).not.toContain(grantId);
    expect(trace).not.toContain(relayed);
    expect(await relayIds()).toEqual([]);
  });

  it('a relay can answer the key\'s own ask item; deleting it puts the item back to pending', async () => {
    const ask = (await call(secretKey, 'ask_owner', { decision: 'where to live', why_needed: 'w', items: [{ question_id: Q_TEXT }] })).structuredContent;
    const other = (await owner(handleMeGrantsRoutes, 'POST', '/api/me/grants', { label: 'other', ceiling: 'Secret' })).body.key;
    expect((await call(other, 'record_answer', { ask_id: ask.ask_id, position: 0, answer: 'x' })).isError).toBe(true);

    const r = await call(secretKey, 'record_answer', { ask_id: ask.ask_id, position: 0, answer: 'quiet streets' });
    expect(r.isError).toBe(false);
    let asked = (await call(secretKey, 'get_asked')).structuredContent.asks.find((a: any) => a.ask_id === ask.ask_id);
    expect(asked.status).toBe('answered');
    expect(asked.items[0]).toMatchObject({ state: 'answered', answer: 'quiet streets', provenance: 'relayed' });

    expect((await inbox('POST', `/api/me/inbox/relays/${r.structuredContent.answer_id}/delete`)).body.ok).toBe(true);
    expect(await env.DB.prepare('SELECT id FROM Answers WHERE id = ?').bind(r.structuredContent.answer_id).first()).toBeNull();
    const after = (await call(secretKey, 'get_asked')).structuredContent;
    asked = after.asks.find((a: any) => a.ask_id === ask.ask_id);
    expect(asked.status).toBe('pending');
    expect(asked.items[0].state).toBe('pending');
    // The key that recorded it is told it was withdrawn: ids and the day, never the answer.
    const w = after.withdrawn.find((x: any) => x.answer_id === r.structuredContent.answer_id);
    expect(w).toEqual({ answer_id: r.structuredContent.answer_id, question_id: Q_TEXT, ask_id: ask.ask_id, position: 0, withdrawn_on: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    expect(JSON.stringify(after.withdrawn)).not.toContain('quiet streets');
    expect(after.withdrawn_note).toMatch(/drop them/);
    // Other keys aren't told.
    expect((await call(other, 'get_asked')).structuredContent.withdrawn).toBeUndefined();
  });

  it('revoking a key can delete its unconfirmed relays; confirmed ones stay', async () => {
    const temp = (await owner(handleMeGrantsRoutes, 'POST', '/api/me/grants', { label: 'temp', ceiling: 'Secret' })).body.key;
    const kept = (await call(temp, 'record_answer', { stem: 'Do you like dogs?', answer: 'yes' })).structuredContent.answer_id;
    await inbox('POST', `/api/me/inbox/relays/${kept}/confirm`, {});
    const dropped = (await call(temp, 'record_answer', { stem: 'Do you like cats?', answer: 'no' })).structuredContent.answer_id;

    const grants = (await owner(handleMeGrantsRoutes, 'GET', '/api/me/grants')).body.grants;
    const g = grants.find((x: any) => x.label === 'temp');
    expect(g.unconfirmed_relays).toBe(1);
    const res = await owner(handleMeGrantsRoutes, 'DELETE', `/api/me/grants/${g.id}?relays=delete`);
    expect(res.body).toEqual({ revoked: true, relays_deleted: 1 });
    expect(await env.DB.prepare('SELECT id FROM owner_answers WHERE id = ?').bind(dropped).first()).toBeNull();
    expect(await env.DB.prepare('SELECT id FROM owner_answers WHERE id = ?').bind(kept).first()).not.toBeNull();
    expect(await relayIds()).toEqual([]);
    // A revoked key reads nothing, so it isn't told about the deletion.
    const { keys } = await env.KV_USER_PROFILES.list({ prefix: `relay-withdrawn:${g.id}:` });
    expect(keys).toEqual([]);
  });

  it('confirming as Anon is refused when an earlier Public answer would make it Public', async () => {
    await env.DB.prepare(`INSERT INTO Answers (id, q_id, user_id, value, answer_type_id, audience, created_at) VALUES ('pub-1', '${Q_TEXT}', ${ME}, 'buses', '1', 'Public', '2026-01-01T00:00:00.000Z')`).run();
    const id = (await call(secretKey, 'record_answer', { question_id: Q_TEXT, answer: 'bike lanes' })).structuredContent.answer_id;
    const res = await inbox('POST', `/api/me/inbox/relays/${id}/confirm`, { audience: 'Anon' });
    expect(res.status).toBe(409);
    expect(await relayIds()).toEqual([id]);
    expect((await env.DB.prepare('SELECT audience FROM Answers WHERE id = ?').bind(id).first() as any).audience).toBe('Private');
    await inbox('POST', `/api/me/inbox/relays/${id}/delete`);
  });

  it('one relay per ask item; the write is logged to the day; confirm-all leaves one that won\'t open', async () => {
    const ask = (await call(secretKey, 'ask_owner', { decision: 'pets', why_needed: 'w', items: [{ stem: 'Do you like ferrets?' }] })).structuredContent;
    const askRow = await env.DB.prepare('SELECT * FROM asks WHERE id = ?').bind(ask.ask_id).first() as any;
    await call(secretKey, 'record_answer', { ask_id: ask.ask_id, position: 0, answer: 'yes' });
    // Even if the item mark had not landed, a second copy is refused.
    await env.DB.prepare('UPDATE asks SET sealed = ?, status = ? WHERE id = ?').bind(askRow.sealed, 'pending', ask.ask_id).run();
    expect((await call(secretKey, 'record_answer', { ask_id: ask.ask_id, position: 0, answer: 'no' })).content[0].text).toMatch(/already recorded/);

    const logged = await env.DB.prepare("SELECT at FROM grant_reads WHERE tool = 'record_answer' ORDER BY id DESC LIMIT 1").first() as any;
    expect(Number(logged.at) % 86_400_000).toBe(0);

    const broken = (await call(secretKey, 'record_answer', { question_id: Q_TEXT, answer: 'trams' })).structuredContent.answer_id;
    await env.DB.prepare("UPDATE Answers SET storage_ref = 'qstorage:answers/private/missing' WHERE id = ?").bind(broken).run();
    expect((await inbox('POST', '/api/me/inbox/relays/confirm-all')).body).toMatchObject({ ok: true, confirmed: 1 });
    expect(await relayIds()).toEqual([broken]);
    await inbox('POST', `/api/me/inbox/relays/${broken}/delete`);
  });

  it('a revoked key\'s unconfirmed relays can be deleted later', async () => {
    const k = await owner(handleMeGrantsRoutes, 'POST', '/api/me/grants', { label: 'later', ceiling: 'Secret' });
    await call(k.body.key, 'record_answer', { stem: 'Do you like birds?', answer: 'yes' });
    expect((await owner(handleMeGrantsRoutes, 'DELETE', `/api/me/grants/${k.body.grant.id}`)).body).toEqual({ revoked: true, relays_deleted: 0 });
    expect(await relayIds()).toHaveLength(1);
    expect((await owner(handleMeGrantsRoutes, 'DELETE', `/api/me/grants/${k.body.grant.id}?relays=delete`)).body).toEqual({ revoked: true, relays_deleted: 1 });
    expect(await relayIds()).toEqual([]);
  });
});
