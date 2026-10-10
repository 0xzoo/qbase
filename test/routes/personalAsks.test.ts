/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Personal MCP P1 (docs/specs/personal-mcp.md §3.2–3.3, migration 0081):
 * ask_owner writes an ask to the owner's inbox, the owner answers at
 * /api/me/inbox, get_asked reads the answers back under the key's ceiling.
 * New stems become owner-only questions, sealed, never in `queries`.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { env } from 'cloudflare:test';
import grantsMigration from '../../migrations/0079_grants.sql?raw';
import copyV2 from '../../migrations/0080_mcp_key_copy_v2.sql?raw';
import asksMigration from '../../migrations/0081_asks.sql?raw';
import { handleMcpRoute } from '../../worker/routes/mcp';
import { handleMeGrantsRoutes } from '../../worker/routes/me-grants';
import { handleMeInboxRoutes } from '../../worker/routes/me-inbox';
import { setObjectStoreForTests, type ObjectStore } from '../../worker/services/secret/SecretStore';

class MemStore implements ObjectStore {
  objects = new Map<string, string>();
  async put(key: string, data: string) { this.objects.set(key, data); return { success: true, key }; }
  async get(key: string) { const t = this.objects.get(key); return t === undefined ? null : { data: new TextEncoder().encode(t).buffer as ArrayBuffer }; }
  async delete(key: string) { return this.objects.delete(key); }
}
const b64 = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
// An account id (≥ 2^40) with no linked Farcaster: answering never needs a Farcaster profile.
const ME = 2 ** 40 + 31, ANON = 514282, SESSION = 'personal-asks-session';
const Q_MC = '33333333-3333-4333-8333-333333333333';
const Q_FAIR = '44444444-4444-4444-8444-444444444444';
const testEnv = {
  ...env,
  ANSWER_KEKS: b64(), ANON_TAG_KEY: b64(), ANON_FID: String(ANON), OPENROUTER_API_KEY: 'test-key',
  ANSWER_CAST_QUEUE: { send: async () => {} },
  AI: { run: async (_m: string, { text }: { text: string[] }) => ({ data: (text ?? ['x']).map(() => [0.1, 0.2, 0.3]) }) },
  AINDEX: { upsert: async () => ({ mutationId: 'm', ids: [] }), insert: async () => ({ mutationId: 'm', ids: [] }) },
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

let secretKey = '', publicKey = '', askId = '';

describe('personal MCP P1: asks and the inbox', () => {
  beforeAll(async () => {
    setObjectStoreForTests(new MemStore());
    for (const stmt of `${grantsMigration}\n${copyV2}\n${asksMigration}`.split(/;\s*$/m).map((s) => s.trim()).filter(Boolean)) {
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
         ('${Q_MC}', 'Do you value remote work?', 'mc', '["yes","no"]', '2026-09-01'),
         ('${Q_FAIR}', 'What is a fair ballot?', 'text', NULL, '2026-09-01')`,
    ]) await env.DB.prepare(sql).run();
    await env.KV_USER_PROFILES.put(`session:${SESSION}`, JSON.stringify({ accountId: ME, expiresAt: Date.now() + 3_600_000 }));

    secretKey = (await owner(handleMeGrantsRoutes, 'POST', '/api/me/grants', { label: 'claude code', ceiling: 'Secret' })).body.key;
    publicKey = (await owner(handleMeGrantsRoutes, 'POST', '/api/me/grants', { label: 'public only' })).body.key;
  });
  afterAll(() => setObjectStoreForTests(null));

  it('ask_owner writes an ask; a new stem becomes an owner-only question and an exact repeat is reused', async () => {
    const r = await call(secretKey, 'ask_owner', {
      decision: 'which job offer to take',
      why_needed: 'your answers decide which offer fits',
      note: 'the Acme offer is remote, the Globex one is not',
      items: [
        { question_id: Q_MC },
        { stem: 'Would you take a pay cut to work at Acme?', type: 'text' },
        { stem: '  what is a FAIR ballot? ', type: 'text' },
      ],
    });
    expect(r.isError).toBe(false);
    const data = r.structuredContent;
    askId = data.ask_id;
    expect(data.items.map((i: any) => [i.owner_only, i.reused])).toEqual([[false, true], [true, false], [false, true]]);
    expect(data.items[1].question_id).toMatch(/^oq_/);
    expect(data.items[2].question_id).toBe(Q_FAIR);

    // Nothing about the owner is plaintext: not the note, not the owner-only stem, not which public questions were asked.
    const rows = JSON.stringify([
      ...(await env.DB.prepare('SELECT * FROM asks').all()).results,
      ...(await env.DB.prepare('SELECT * FROM owner_questions').all()).results,
    ]);
    expect(rows).not.toContain('Acme');
    expect(rows).not.toContain(Q_MC);
    expect(await env.DB.prepare("SELECT id FROM queries WHERE stem LIKE '%Acme%'").first()).toBeNull();
  });

  it('the owner sees the ask in their inbox; an agent key cannot', async () => {
    const r = await inbox('GET', '/api/me/inbox');
    expect(r.status).toBe(200);
    expect(r.body.pending).toBe(1);
    const ask = r.body.asks[0];
    expect(ask).toMatchObject({ id: askId, agent: 'claude code', decision: 'which job offer to take', note: 'the Acme offer is remote, the Globex one is not' });
    expect(ask.items[0].question).toMatchObject({ id: Q_MC, type: 'mc', options: ['yes', 'no'], owner_only: false });
    expect(ask.items[1].question.stem).toBe('Would you take a pay cut to work at Acme?');
    expect((await inbox('GET', '/api/me/inbox', undefined, secretKey)).status).toBe(401);
    expect((await inbox('GET', '/api/me/inbox?count=1')).body).toEqual({ pending: 1, keys: 2 });
  });

  it('answers: a public item through the normal path at Secret, an owner-only item sealed, a skip closes the ask', async () => {
    expect((await inbox('POST', `/api/me/inbox/${askId}/items/0`, { answer: 'maybe' })).status).toBe(400);
    const a0 = await inbox('POST', `/api/me/inbox/${askId}/items/0`, { answer: 'yes', reasoning: 'no commute' });
    expect(a0.body).toMatchObject({ ok: true, audience: 'Secret', status: 'pending' });
    const row = await env.DB.prepare('SELECT audience, value FROM Answers WHERE q_id = ? AND user_id = ?').bind(Q_MC, ME).first() as any;
    expect(row).toEqual({ audience: 'Private', value: '[encrypted]' });

    const a1 = await inbox('POST', `/api/me/inbox/${askId}/items/1`, { answer: 'yes, up to 10%' });
    expect(a1.body).toMatchObject({ ok: true, audience: 'Secret' });
    const owned = await env.DB.prepare('SELECT sealed FROM owner_answers WHERE owner_key = ?').bind(ME).first() as any;
    expect(owned.sealed).not.toContain('10%');

    const s2 = await inbox('POST', `/api/me/inbox/${askId}/items/2/skip`);
    expect(s2.body).toEqual({ ok: true, status: 'answered' });
    expect((await inbox('GET', '/api/me/inbox')).body.pending).toBe(0);
  });

  it('get_asked returns the answers to the key that asked', async () => {
    const r = await call(secretKey, 'get_asked');
    const items = r.structuredContent.asks[0].items;
    expect(items[0]).toMatchObject({ state: 'answered', answer: 'yes', reasoning: 'no commute', tier: 'Secret' });
    expect(items[1]).toMatchObject({ state: 'answered', answer: 'yes, up to 10%', owner_only: true, tier: 'Secret' });
    expect(items[2]).toMatchObject({ state: 'skipped' });
    // Only this key's asks; another key sees none of them.
    expect((await call(publicKey, 'get_asked')).structuredContent.asks).toEqual([]);
  });

  it('a key below Secret cannot ask an owner-only question', async () => {
    const r = await call(publicKey, 'ask_owner', { decision: 'where to live', why_needed: 'rent matters', items: [{ stem: 'Monthly rent ceiling?', type: 'scale', scale: { min: 1, max: 5 } }] });
    expect(r.isError).toBe(true);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM owner_questions').first() as any).n).toBe(1);
  });

  it('an answer above the asking key\'s ceiling stays pending to that key, so it can\'t time an Anon row', async () => {
    const r = await call(publicKey, 'ask_owner', { decision: 'remote or not', why_needed: 'w', items: [{ question_id: Q_MC }] });
    expect(r.isError).toBe(false);
    const id = r.structuredContent.ask_id;
    const listed = (await inbox('GET', '/api/me/inbox')).body.asks.find((a: any) => a.id === id);
    expect(listed.agent_reads).toEqual({ ceiling: 'Public', disclosure: 'raw' });

    expect((await inbox('POST', `/api/me/inbox/${id}/items/0`, { answer: 'no', audience: 'Anon' })).body).toMatchObject({ ok: true, audience: 'Anon', status: 'answered' });
    expect((await inbox('POST', `/api/me/inbox/${id}/items/0`, { answer: 'yes', audience: 'Anon' })).status).toBe(409);
    const seen = (await call(publicKey, 'get_asked')).structuredContent.asks.find((a: any) => a.ask_id === id);
    expect(seen.status).toBe('pending');
    expect(seen.items[0]).toEqual({ question_id: Q_MC, stem: 'Do you value remote work?', owner_only: false, state: 'pending' });
    expect((await call(publicKey, 'get_asked', { status: 'answered' })).structuredContent.asks).toEqual([]);
  });

  it('two items saved at once both stick', async () => {
    const r = await call(secretKey, 'ask_owner', { decision: 'concurrent', why_needed: 'w', items: [{ question_id: Q_FAIR }, { stem: 'Concurrent saves?', type: 'text' }] });
    const id = r.structuredContent.ask_id;
    const [x, y] = await Promise.all([
      inbox('POST', `/api/me/inbox/${id}/items/0`, { answer: 'one' }),
      inbox('POST', `/api/me/inbox/${id}/items/1`, { answer: 'two' }),
    ]);
    expect([x.status, y.status]).toEqual([200, 200]);
    const ask = (await inbox('GET', '/api/me/inbox?status=all')).body.asks.find((a: any) => a.id === id);
    expect(ask.status).toBe('answered');
    expect(ask.items.map((i: any) => i.answered)).toEqual([true, true]);
  });

  it('owner-only answers join the record for a Secret key, sealed stem and all', async () => {
    const r = await call(secretKey, 'list_my_answers');
    const own = r.structuredContent.answers.find((a: any) => a.stem === 'Would you take a pay cut to work at Acme?');
    expect(own).toMatchObject({ answer: 'yes, up to 10%', tier: 'Secret' });
    const pub = await call(publicKey, 'list_my_answers');
    expect(JSON.stringify(pub.structuredContent)).not.toContain('Acme');
  });

  it('a declined ask is closed; each key may hold at most five unanswered asks', async () => {
    const asks: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await call(secretKey, 'ask_owner', { decision: `d${i}`, why_needed: 'w', items: [{ question_id: Q_FAIR }] });
      expect(r.isError).toBe(false);
      asks.push(r.structuredContent.ask_id);
    }
    const over = await call(secretKey, 'ask_owner', { decision: 'd6', why_needed: 'w', items: [{ question_id: Q_FAIR }] });
    expect(over.isError).toBe(true);
    expect((await inbox('POST', `/api/me/inbox/${asks[0]}/decline`)).body.ok).toBe(true);
    expect((await inbox('POST', `/api/me/inbox/${asks[0]}/items/0`, { answer: 'x' })).status).toBe(409);
    expect((await call(secretKey, 'ask_owner', { decision: 'd7', why_needed: 'w', items: [{ question_id: Q_FAIR }] })).isError).toBe(false);
  });
});
