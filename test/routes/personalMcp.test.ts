/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * /mcp + /api/me/grants (personal MCP P0, docs/specs/personal-mcp.md §5):
 * key grants minted by the signed-in owner, JSON-RPC over streamable HTTP,
 * the grant's ceiling and disclosure enforced per tool, every call logged in
 * grant_reads, revocation forward-only. Schema from migrations/0079.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import migration from '../../migrations/0079_grants.sql?raw';
import copyV2 from '../../migrations/0080_mcp_key_copy_v2.sql?raw';
import { handleMcpRoute } from '../../worker/routes/mcp';
import { handleMeGrantsRoutes } from '../../worker/routes/me-grants';
import { attributionStatement } from '../../worker/services/AnonAttributionService';
import { setObjectStoreForTests, SecretStore, type ObjectStore } from '../../worker/services/secret/SecretStore';

class MemStore implements ObjectStore {
  objects = new Map<string, string>();
  async put(key: string, data: string) { this.objects.set(key, data); return { success: true, key }; }
  async get(key: string) { const t = this.objects.get(key); return t === undefined ? null : { data: new TextEncoder().encode(t).buffer as ArrayBuffer }; }
  async delete(key: string) { return this.objects.delete(key); }
}
const b64 = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const ME = 21, OTHER = 22, ANON = 514282, SESSION = 'personal-mcp-session';
/** Deterministic fake embedding: letters histogram, so 'vote' is nearest the voting stem. */
const fakeEmbed = (t: string) => Array.from({ length: 26 }, (_, i) => [...t.toLowerCase()].filter((c) => c.charCodeAt(0) - 97 === i).length);
const testEnv = {
  DB: env.DB, KV_USER_PROFILES: env.KV_USER_PROFILES, RATE_LIMIT: env.RATE_LIMIT,
  ANSWER_KEKS: b64(), ANON_TAG_KEY: b64(), ANON_FID: String(ANON), OPENROUTER_API_KEY: 'test-key',
  AI: { run: async (_m: string, { text }: { text: string[] }) => ({ data: text.map(fakeEmbed) }) },
};

const tax = (o: object) => `'${JSON.stringify({ topics: ['civic'], ...o })}'`;

async function owner(method: string, path: string, body?: unknown) {
  const res = await handleMeGrantsRoutes(new Request(`http://x${path}`, {
    method, headers: { Authorization: `Bearer ${SESSION}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), testEnv);
  return { status: res!.status, body: await res!.json() as Record<string, any> };
}

let rpcId = 0;
async function rpc(key: string | null, method: string, params?: unknown) {
  const res = await handleMcpRoute(new Request('http://x/mcp', {
    method: 'POST',
    headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  }), testEnv);
  return { status: res!.status, body: res!.status === 202 ? null : await res!.json() as Record<string, any> };
}
const call = async (key: string, name: string, args: object = {}) => (await rpc(key, 'tools/call', { name, arguments: args })).body!.result;
const reads = async (grantId: string) => ((await env.DB.prepare('SELECT tool, answer_count, max_tier FROM grant_reads WHERE grant_id = ? ORDER BY id').bind(grantId).all()).results);

let secretKey = '', secretGrant = '', publicKey = '', derivedKey = '';

describe('personal MCP', () => {
  beforeAll(async () => {
    setObjectStoreForTests(new MemStore());
    for (const stmt of `${migration}\n${copyV2}`.split(/;\s*$/m).map((s) => s.trim()).filter(Boolean)) await env.DB.prepare(stmt).run();
    for (const sql of [
      `CREATE TABLE IF NOT EXISTS queries (id TEXT PRIMARY KEY, stem TEXT, type TEXT, a_options TEXT, scale_config TEXT, taxonomy TEXT, created_at TEXT, coiner_id INTEGER, owner_id INTEGER)`,
      `CREATE TABLE IF NOT EXISTS Answers (id TEXT PRIMARY KEY, q_id TEXT NOT NULL, user_id INTEGER, value TEXT, answer_type_id TEXT, answer_data TEXT, audience TEXT, created_at TEXT, storage_ref TEXT, poll_id TEXT, quiz_completion_id TEXT, reasoning TEXT)`,
      `CREATE TABLE IF NOT EXISTS anon_attributions (id TEXT PRIMARY KEY, public_id TEXT NOT NULL UNIQUE, author_id INTEGER, author_tag TEXT, author_ct TEXT, type TEXT NOT NULL, created_at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS quiz_completions (id TEXT PRIMARY KEY, quiz_id TEXT, user_id INTEGER, completed_at INTEGER, scores TEXT, result_category TEXT, visibility TEXT, created_at INTEGER)`,
      `INSERT OR IGNORE INTO queries (id, stem, type, a_options, taxonomy, created_at, coiner_id, owner_id) VALUES
         ('pm-vote', 'should corporations vote?', 'mc', '["yes","no"]', ${tax({ mode: 'stance', referent: 'world' })}, '2026-01-01', ${OTHER}, ${OTHER}),
         ('pm-food', 'favourite cuisine?', 'text', NULL, ${tax({ mode: 'stance', referent: 'self', content_tags: ['preference'] })}, '2026-01-01', ${OTHER}, ${OTHER}),
         ('pm-anon', 'trust institutions?', 'text', NULL, ${tax({ mode: 'stance', referent: 'world' })}, '2026-01-01', ${OTHER}, ${OTHER}),
         ('pm-mine', 'what is a fair ballot?', 'text', NULL, ${tax({ mode: 'stance' })}, '2026-02-01', ${ME}, ${ME})`,
      `INSERT OR IGNORE INTO Answers (id, q_id, user_id, value, answer_type_id, audience, created_at, storage_ref, reasoning) VALUES
         ('pm-v1', 'pm-vote', ${ME}, 'yes', '2', 'Public', '2026-03-01T00:00:00.000Z', NULL, NULL),
         ('pm-v2', 'pm-vote', ${ME}, 'no', '2', 'Public', '2026-09-01T00:00:00.000Z', NULL, 'changed my mind'),
         ('pm-f1', 'pm-food', ${ME}, '[encrypted]', '1', 'Private', '2026-09-02T00:00:00.000Z', 'qstorage:answers/private/pm-f1', NULL),
         ('pm-n1', 'pm-anon', ${ANON}, 'not much', '1', 'Anon', '2026-09-03T00:00:00.000Z', NULL, NULL),
         ('pm-o1', 'pm-vote', ${OTHER}, 'someone else', '2', 'Public', '2026-09-04T00:00:00.000Z', NULL, NULL)`,
      `INSERT OR IGNORE INTO quiz_completions (id, quiz_id, user_id, completed_at, scores, result_category, visibility, created_at) VALUES
         ('pm-c1', 'values', ${ME}, 1778457386000, '{"autonomy":0.8}', 'autonomy', 'private', 1778457386000),
         ('pm-c2', 'bartlet', ${ME}, 1778457386000, '{"dominant":"Socializer"}', 'Host', 'public', 1778457386000)`,
    ]) await env.DB.prepare(sql).run();
    await (await attributionStatement(testEnv, { public_id: 'pm-n1', fid: ME, type: 'answer', scope_id: 'pm-anon' })).run();
    await SecretStore.putJSON(testEnv, 'answers/private/pm-f1', { value: 'ramen', reasoning: 'broth' }, { tier: 'Private', owner: ME });
    await env.KV_USER_PROFILES.put(`session:${SESSION}`, JSON.stringify({ fid: ME, expiresAt: Date.now() + 3_600_000 }));
  });
  afterAll(() => setObjectStoreForTests(null));
  afterEach(() => vi.restoreAllMocks());

  it('the owner mints keys; the secret is shown once and only its hash is stored', async () => {
    const s = await owner('POST', '/api/me/grants', { label: 'yu via hermes', ceiling: 'Secret', disclosure: 'raw', purpose: 'dogfood' });
    expect(s.status).toBe(201);
    expect(s.body.key).toMatch(/^qb_[A-Za-z0-9_-]{43}$/);
    expect(s.body.grant.ceiling).toBe('Secret');
    expect(s.body.grant.copy_id).toBe('mcp-key-v2');
    secretKey = s.body.key; secretGrant = s.body.grant.id;
    const stored = await env.DB.prepare('SELECT key_hash, key_hint FROM grants WHERE id = ?').bind(secretGrant).first() as Record<string, string>;
    expect(stored.key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.key_hash).not.toContain(secretKey.slice(3));
    expect(stored.key_hint).toBe(secretKey.slice(-4));

    publicKey = (await owner('POST', '/api/me/grants', { label: 'public only' })).body.key;
    derivedKey = (await owner('POST', '/api/me/grants', { label: 'derived', ceiling: 'Secret', disclosure: 'derived' })).body.key;
    expect((await owner('POST', '/api/me/grants', { ceiling: 'Everything' })).status).toBe(400);
  });

  it('refuses requests without a valid key, and an agent key cannot manage grants', async () => {
    expect((await rpc(null, 'tools/list')).status).toBe(401);
    expect((await rpc('qb_not-a-real-key-at-all-xxxxxxxxxxxxxxxxxxxxxxx', 'tools/list')).status).toBe(401);
    const res = await handleMeGrantsRoutes(new Request('http://x/api/me/grants', { headers: { Authorization: `Bearer ${secretKey}` } }), testEnv);
    expect(res!.status).toBe(401);
    const get = await handleMcpRoute(new Request('http://x/mcp'), testEnv);
    expect(get!.status).toBe(405);
  });

  it('speaks MCP: initialize, initialized, tools/list, unknown method', async () => {
    const init = await rpc(secretKey, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'hermes', version: '1' } });
    expect(init.body!.result.protocolVersion).toBe('2025-06-18');
    expect(init.body!.result.capabilities.tools).toBeDefined();
    expect(init.body!.result.serverInfo.name).toBe('qbase');
    expect((await rpc(secretKey, 'initialize', { protocolVersion: '1999-01-01' })).body!.result.protocolVersion).toBe('2025-11-25');

    const note = await handleMcpRoute(new Request('http://x/mcp', {
      method: 'POST', headers: { Authorization: `Bearer ${secretKey}` },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    }), testEnv);
    expect(note!.status).toBe(202);

    const list = await rpc(secretKey, 'tools/list');
    expect(list.body!.result.tools.map((t: { name: string }) => t.name)).toEqual(
      ['get_context', 'search_my_positions', 'get_answer_history', 'list_my_answers', 'get_profile']);
    expect((await rpc(secretKey, 'resources/list')).body!.error.code).toBe(-32601);
  });

  it('a Secret key reads Secret and Anon rows, opened; the read is logged', async () => {
    const r = await call(secretKey, 'list_my_answers');
    expect(r.isError).toBe(false);
    const byQ = Object.fromEntries(r.structuredContent.answers.map((a: any) => [a.question_id, a]));
    expect(byQ['pm-food'].answer).toBe('ramen');
    expect(byQ['pm-food'].reasoning).toBe('broth');
    expect(byQ['pm-food'].tier).toBe('Secret');
    expect(byQ['pm-anon'].answer).toBe('not much');
    expect(byQ['pm-vote'].answer).toBe('no');
    expect(byQ['pm-vote'].history).toEqual([{ answer: 'yes', at: '2026-03-01T00:00:00.000Z' }]);
    expect(JSON.stringify(r)).not.toContain('someone else');
    expect(await reads(secretGrant)).toEqual([{ tool: 'list_my_answers', answer_count: 4, max_tier: 'Secret' }]);
  });

  it('a Public key never sees Secret or Anon rows', async () => {
    const r = await call(publicKey, 'list_my_answers', { source: 'all' });
    const text = JSON.stringify(r);
    expect(text).not.toContain('ramen');
    expect(text).not.toContain('not much');
    expect(r.structuredContent.answers.map((a: any) => a.question_id)).toEqual(['pm-vote']);
    const h = await call(publicKey, 'get_answer_history', { question_id: 'pm-food' });
    expect(h.structuredContent.answers).toEqual([]);
  });

  it('a Public key gets public quiz results only (consent-model §3.7)', async () => {
    const p = (await call(publicKey, 'get_profile')).structuredContent;
    expect(p.measured.map((m: any) => m.quiz_id)).toEqual(['bartlet']);
    expect(JSON.stringify(p)).not.toContain('autonomy');
    const s = (await call(secretKey, 'get_profile')).structuredContent;
    expect(s.measured.map((m: any) => m.quiz_id).sort()).toEqual(['bartlet', 'values']);
    expect(s.measured[0].visibility).toBeUndefined();
  });

  it('get_answer_history returns every answer, newest first', async () => {
    const h = await call(secretKey, 'get_answer_history', { question_id: 'pm-vote' });
    expect(h.structuredContent.answers.map((a: any) => [a.answer, a.reasoning])).toEqual([['no', 'changed my mind'], ['yes', null]]);
    expect(h.structuredContent.options).toEqual(['yes', 'no']);
  });

  it('get_context: the selector sees stems only; picked Secret rows are opened and logged', async () => {
    const seen: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String((init as RequestInit).body));
      seen.push(body.messages[1].content);
      const list: string = body.messages[1].content;
      const n = (stem: string) => list.split('\n').find((l) => l.includes(stem))!.split('.')[0];
      return Response.json({ choices: [{ message: { content: JSON.stringify({
        relevant: [{ n: Number(n('should corporations vote?')), why: 'civic stance' }, { n: Number(n('favourite cuisine?')), why: 'n/a' }, { n: Number(n('fair ballot')), why: 'they asked' }],
        gaps: ['where do you live?'],
      }) } }] });
    });
    const r = await call(secretKey, 'get_context', { decision: 'who should I vote for' });
    expect(seen[0]).toContain('should corporations vote? (yes / no)');
    expect(seen[0]).not.toContain('ramen');
    expect(seen[0]).not.toContain('changed my mind');
    const b = r.structuredContent;
    expect(b.selection).toBe('model');
    expect(b.groups.values[0]).toMatchObject({ question_id: 'pm-vote', answer: 'no', why: 'civic stance' });
    expect(b.groups.preferences[0].answer).toBe('ramen');
    expect(b.asked.map((a: any) => a.question_id)).toEqual(['pm-mine']);
    expect(b.coverage.gaps).toEqual(['where do you live?']);
    expect(b.measured.find((m: any) => m.quiz_id === 'values')).toMatchObject({ result: 'autonomy', provenance: 'measured' });
    expect((await reads(secretGrant)).at(-1)).toEqual({ tool: 'get_context', answer_count: 3, max_tier: 'Secret' });
  });

  it('get_context degrades to no selection when the model is down', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 503 }));
    const b = (await call(secretKey, 'get_context', { decision: 'dinner' })).structuredContent;
    expect(b.selection).toBe('fallback');
    expect(b.groups).toEqual({});
    expect((await reads(secretGrant)).at(-1)).toEqual({ tool: 'get_context', answer_count: 0, max_tier: null });
  });

  it('search_my_positions ranks by similarity and opens what it returns', async () => {
    const r = await call(secretKey, 'search_my_positions', { query: 'cuisine', limit: 1 });
    expect(r.structuredContent.results).toHaveLength(1);
    expect(r.structuredContent.results[0]).toMatchObject({ question_id: 'pm-food', answer: 'ramen' });
  });

  it('a derived key gets scores and counts, never answers', async () => {
    const raw = await call(derivedKey, 'list_my_answers');
    expect(raw.isError).toBe(true);
    expect(raw.content[0].text).toMatch(/derived/);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ choices: [{ message: { content: '{"relevant":[{"n":1,"why":"x"}],"gaps":[]}' } }] }));
    const ctx = (await call(derivedKey, 'get_context', { decision: 'anything' })).structuredContent;
    expect(ctx.groups).toBeUndefined();
    const p = (await call(derivedKey, 'get_profile')).structuredContent;
    expect(p.measured.find((m: any) => m.quiz_id === 'values').result).toBe('autonomy');
    expect(p.coverage.answered_total).toBe(3);
    expect(p.goals).toBeUndefined();
    const text = JSON.stringify([ctx, p]);
    expect(text).not.toContain('ramen');
    expect(text).not.toContain('not much');
  });

  it('bad tool input is a tool error, not a protocol error', async () => {
    const r = await call(secretKey, 'get_context', {});
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/decision is required/);
    expect((await rpc(secretKey, 'tools/call', { name: 'answer_for_me' })).body!.error.code).toBe(-32602);
  });

  it('the owner sees grants with their reads, and revoking stops the key', async () => {
    const list = await owner('GET', '/api/me/grants');
    const g = list.body.grants.find((x: any) => x.id === secretGrant);
    expect(g.reads.total).toBeGreaterThanOrEqual(5);
    expect(g.recent[0].tool).toBeDefined();
    expect(g.key_hash).toBeUndefined();
    expect(list.body.copy.id).toBe('mcp-key-v2');
    expect(list.body.copy.text).toMatch(/model provider/);

    expect((await owner('DELETE', `/api/me/grants/${secretGrant}`)).status).toBe(200);
    expect((await owner('DELETE', `/api/me/grants/${secretGrant}`)).status).toBe(404);
    expect((await rpc(secretKey, 'tools/list')).status).toBe(401);
  });
});
