/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * find_questions (docs/plans/2026-10-11-question-hygiene.md): an agent looks
 * for an existing public question before writing a new one. Public questions
 * only, near the query, askable types; whether the owner answered only for
 * keys that read answers.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import grantsMigration from '../../migrations/0079_grants.sql?raw';
import copyV2 from '../../migrations/0080_mcp_key_copy_v2.sql?raw';
import asksMigration from '../../migrations/0081_asks.sql?raw';
import relaysMigration from '../../migrations/0082_relays.sql?raw';
import { handleMcpRoute } from '../../worker/routes/mcp';
import { handleMeGrantsRoutes } from '../../worker/routes/me-grants';

const ME = 2 ** 40 + 61, SESSION = 'find-questions-session';
/** Letter histogram: stems sharing words land close. */
const embed = (t: string) => Array.from({ length: 26 }, (_, i) => [...t.toLowerCase()].filter((c) => c.charCodeAt(0) - 97 === i).length);
const cos = (a: number[], b: number[]) => {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] ** 2; nb += b[i] ** 2; }
  return d / Math.sqrt(na * nb || 1);
};
const b64 = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const testEnv = {
  ...env,
  OPENROUTER_API_KEY: 'test-key', ANSWER_KEKS: b64(),
  AI: { run: async (_m: string, { text }: { text: string | string[] }) => ({ data: [text].flat().map(embed) }) },
  QINDEX: {
    query: async (v: number[], o: { topK: number }) => {
      const { results } = await env.DB.prepare('SELECT id, stem FROM queries').all();
      const matches = (results as any[]).map((r) => ({ id: r.id, score: cos(v, embed(r.stem)) }))
        .sort((a, b) => b.score - a.score).slice(0, o.topK);
      return { matches, count: matches.length };
    },
  },
};

async function grant(body: object) {
  const res = await handleMeGrantsRoutes(new Request('http://x/api/me/grants', {
    method: 'POST', headers: { Authorization: `Bearer ${SESSION}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }), testEnv);
  return ((await res!.json()) as any).key as string;
}
let rpcId = 0;
async function call(key: string, name: string, args: object) {
  const res = await handleMcpRoute(new Request('http://x/mcp', {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }),
  }), testEnv);
  return ((await res!.json()) as any).result;
}
const find = (key: string, args: object) => call(key, 'find_questions', args);

describe('find_questions', () => {
  beforeAll(async () => {
    for (const stmt of `${grantsMigration}\n${copyV2}\n${asksMigration}\n${relaysMigration}`.split(/;\s*$/m).map((s) => s.trim()).filter(Boolean)) {
      await env.DB.prepare(stmt).run();
    }
    for (const sql of [
      `CREATE TABLE IF NOT EXISTS queries (id TEXT PRIMARY KEY, stem TEXT, type TEXT, a_options TEXT, scale_config TEXT, taxonomy TEXT, created_at TEXT,
         coiner_id INTEGER, owner_id INTEGER, pub_answers INTEGER DEFAULT 0, template BOOLEAN DEFAULT FALSE)`,
      `CREATE TABLE IF NOT EXISTS Answers (id TEXT PRIMARY KEY, q_id TEXT NOT NULL, user_id INTEGER, value TEXT, answer_type_id TEXT, answer_data TEXT, audience TEXT, created_at TEXT, storage_ref TEXT, poll_id TEXT, quiz_completion_id TEXT, reasoning TEXT)`,
      `CREATE TABLE IF NOT EXISTS quiz_completions (id TEXT PRIMARY KEY, quiz_id TEXT, user_id INTEGER, completed_at INTEGER, scores TEXT, result_category TEXT, visibility TEXT, created_at INTEGER)`,
      `CREATE TABLE IF NOT EXISTS anon_attributions (id TEXT PRIMARY KEY, public_id TEXT NOT NULL UNIQUE, author_id INTEGER, author_tag TEXT, author_ct TEXT, type TEXT NOT NULL, created_at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS account_credentials (account_id INTEGER, kind TEXT, value TEXT)`,
      `CREATE TABLE IF NOT EXISTS account_migration (id INTEGER PRIMARY KEY, state TEXT, rewritten_at INTEGER)`,
      `INSERT OR IGNORE INTO account_migration (id, state, rewritten_at) VALUES (1, 'rewritten', 1)`,
      `INSERT OR IGNORE INTO queries (id, stem, type, a_options, taxonomy, pub_answers, template) VALUES
         ('fq-remote', 'Would you take a pay cut to work remotely?', 'mc', '["yes","no"]', '{}', 41, 0),
         ('fq-remote2', 'Would you take a pay cut to work remotely full time?', 'text', NULL, '{}', 3, 0),
         ('fq-date', 'Would you take a pay cut to work remotely? (date)', 'date', NULL, '{}', 0, 0),
         ('fq-tmpl', 'Would you take a pay cut to work remotely:', 'mc', '["a","b"]', '{}', 0, 1),
         ('fq-pred', 'Will remote work pay cuts be common?', 'text', NULL, '{"primary_type":"predictive"}', 2, 0),
         ('fq-far', 'zzz qqq xxx', 'text', NULL, '{}', 0, 0)`,
      `INSERT OR IGNORE INTO Answers (id, q_id, user_id, value, answer_type_id, audience, created_at) VALUES
         ('fq-a1', 'fq-remote', ${ME}, 'yes', '2', 'Public', '2026-10-01T00:00:00.000Z')`,
    ]) await env.DB.prepare(sql).run();
    await env.KV_USER_PROFILES.put(`session:${SESSION}`, JSON.stringify({ accountId: ME, expiresAt: Date.now() + 3_600_000 }));
  });

  it('returns askable public questions near the query, with the owner\'s answered flag for a raw key', async () => {
    const r = await find(await grant({ label: 'raw' }), { query: 'would you take a pay cut to work remotely' });
    expect(r.isError).toBe(false);
    const qs = r.structuredContent.questions;
    expect(qs.map((q: any) => q.question_id)).not.toContain('fq-date');
    expect(qs.map((q: any) => q.question_id)).not.toContain('fq-tmpl');
    expect(qs.map((q: any) => q.question_id)).not.toContain('fq-far');
    expect(qs[0]).toMatchObject({ question_id: 'fq-remote', type: 'mc', options: ['yes', 'no'], public_answers: 41, owner_answered: true });
    expect(qs.find((q: any) => q.question_id === 'fq-remote2')).toMatchObject({ owner_answered: false });
  });

  it('a derived key finds questions but learns nothing about the owner', async () => {
    const r = await find(await grant({ label: 'derived', ceiling: 'Secret', disclosure: 'derived' }), { query: 'pay cut to work remotely', limit: 2 });
    expect(r.structuredContent.questions).toHaveLength(2);
    expect(r.structuredContent.questions[0].owner_answered).toBeUndefined();
  });

  it('a Secret key also finds questions written for the owner earlier, so it can reuse them', async () => {
    const key = await grant({ label: 'secret', ceiling: 'Secret' });
    await call(key, 'ask_owner', { decision: 'job', why_needed: 'w', items: [{ stem: 'How much of a pay cut would you take for remote work?' }], force: true });
    const r = await find(key, { query: 'pay cut for remote work' });
    expect(r.structuredContent.owner_only[0]).toMatchObject({ stem: 'How much of a pay cut would you take for remote work?', owner_only: true, owner_answered: false });
    expect((await find(await grant({ label: 'public' }), { query: 'pay cut for remote work' })).structuredContent.owner_only).toBeUndefined();
  });

  it('a domain-scoped key doesn\'t learn whether the owner answered outside its topics', async () => {
    const r = await find(await grant({ label: 'fitness', domains: ['fitness'] }), { query: 'would you take a pay cut to work remotely' });
    expect(r.structuredContent.questions[0]).toMatchObject({ question_id: 'fq-remote', owner_answered: false });
  });

  it('a new stem that rewords a public question is refused once with the match; force writes it', async () => {
    const key = await grant({ label: 'secret2', ceiling: 'Secret' });
    const stem = 'Would you take a pay cut to work remote?';
    const refused = await call(key, 'record_answer', { stem, type: 'mc', options: ['yes', 'no'], answer: 'yes' });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toMatch(/fq-remote/);
    const asked = await call(key, 'ask_owner', { decision: 'd', why_needed: 'w', items: [{ stem, type: 'text' }] });
    expect(asked.isError).toBe(true);
    const forced = await call(key, 'record_answer', { stem, type: 'mc', options: ['yes', 'no'], answer: 'yes', force: true });
    expect(forced.isError).toBe(false);
    expect(forced.structuredContent.owner_only).toBe(true);
  });
});
