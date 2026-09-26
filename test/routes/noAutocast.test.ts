/**
 * Farcaster is a surface: nothing is cast unless someone shares it.
 *
 * Creating a question defaults to no cast; saving an answer enqueues no reply
 * cast (text answers used to go out from @4n0n, Public ones included); the
 * question payload tells the signed-in viewer whether they wrote it (the
 * share menu's input); and @4n0n announces only an anon question, at its
 * author's request.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { handleGetQuery, resolveCastMode } from '../../worker/handlers/queries';
import { handleCreateAnswer } from '../../worker/handlers/answers/create';
import { handleFarcasterRoutes } from '../../worker/routes/farcaster';
import { attributionStatement } from '../../worker/services/AnonAttributionService';

const b64 = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const ME = 17, OTHER = 18, ANON = 514282;
const ME_TOKEN = 'no-autocast-me', OTHER_TOKEN = 'no-autocast-other';
const Q_NAMED = '11111111-1111-4111-8111-111111111111';
const Q_ANON = '22222222-2222-4222-8222-222222222222';

const sent: unknown[] = [];
const testEnv = {
  ...env,
  ANSWER_KEKS: b64(),
  ANON_TAG_KEY: b64(),
  ANON_FID: String(ANON),
  ANSWER_CAST_QUEUE: { send: async (m: unknown) => { sent.push(m); } },
  // embeddings are best-effort on this path; keep them local
  AI: { run: async () => ({ shape: [1, 3], data: [[0.1, 0.2, 0.3]] }) },
  AINDEX: { upsert: async () => ({ mutationId: 'm', ids: [] }), insert: async () => ({ mutationId: 'm', ids: [] }) },
};

const bearer = (token?: string): Record<string, string> => (token ? { Authorization: `Bearer ${token}` } : {});

describe('no automatic casting', () => {
  beforeAll(async () => {
    for (const sql of [
      `CREATE TABLE IF NOT EXISTS queries (id TEXT PRIMARY KEY, stem TEXT NOT NULL, type TEXT NOT NULL, a_options TEXT, scale_config TEXT, date_config TEXT,
         created_at TEXT, coiner_id INTEGER, owner_id INTEGER, coiner_fname TEXT, coiner_fid INTEGER, tags TEXT, reqs TEXT, assets TEXT, parent TEXT,
         pub_answers INTEGER DEFAULT 0, priv_answers INTEGER DEFAULT 0, comments INTEGER DEFAULT 0, taxonomy TEXT, channel_id TEXT, casthash TEXT, token_id TEXT, cost INTEGER DEFAULT 0, template BOOLEAN DEFAULT FALSE)`,
      `CREATE TABLE IF NOT EXISTS farcaster_casts (id TEXT, entity_type TEXT, entity_id TEXT, cast_hash TEXT, cast_url TEXT, caster_fid INTEGER, cached_likes_count INTEGER, cached_recasts_count INTEGER, cached_replies_count INTEGER, stats_synced_at INTEGER)`,
      `CREATE TABLE IF NOT EXISTS farcaster_reactions (id TEXT, cast_hash TEXT, reactor_fid INTEGER, reaction_type TEXT, is_deleted INTEGER DEFAULT 0)`,
      `CREATE TABLE IF NOT EXISTS farcaster_replies (id TEXT, parent_cast_hash TEXT, is_active INTEGER DEFAULT 1)`,
      `CREATE TABLE IF NOT EXISTS question_meta (question_id TEXT PRIMARY KEY, forked_from TEXT)`,
      `CREATE TABLE IF NOT EXISTS polls (id TEXT PRIMARY KEY, question_id TEXT NOT NULL, closes_at TEXT NOT NULL, eligibility_gate TEXT, options_config TEXT, author_fid INTEGER, cast_hash TEXT, created_at TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'measure', channel_id TEXT)`,
      `CREATE TABLE IF NOT EXISTS Answers (id TEXT PRIMARY KEY, q_id TEXT NOT NULL, user_id INTEGER, value TEXT, answer_type_id TEXT, answer_data TEXT, audience TEXT, created_at TEXT, primary_type TEXT, reasoning TEXT, topics TEXT, storage_ref TEXT, poll_id TEXT, quiz_completion_id TEXT)`,
      `CREATE TABLE IF NOT EXISTS answer_meta (id TEXT PRIMARY KEY, question_id TEXT, reply_cast_hash TEXT, replied_to_hash TEXT, responder_fid INTEGER, privacy_tier TEXT, storage_ref TEXT, primary_value TEXT, answer_index INTEGER, pending INTEGER, created_at INTEGER)`,
      `CREATE TABLE IF NOT EXISTS Users (fid INTEGER PRIMARY KEY, fname TEXT, display_name TEXT, pfp_url TEXT, profile_source TEXT)`,
      `INSERT OR IGNORE INTO Users (fid, fname) VALUES (${ME}, 'me'), (${OTHER}, 'other')`,
      `CREATE TABLE IF NOT EXISTS anon_attributions (id TEXT PRIMARY KEY, public_id TEXT NOT NULL UNIQUE, author_id INTEGER, author_tag TEXT, author_ct TEXT, type TEXT NOT NULL, created_at TEXT NOT NULL)`,
      `INSERT OR IGNORE INTO queries (id, stem, type, created_at, coiner_id, coiner_fid) VALUES
         ('${Q_NAMED}', 'What did you learn today?', 'text', '2026-09-01', ${ME}, ${ME}),
         ('${Q_ANON}', 'Anon asks: what scares you?', 'text', '2026-09-02', ${ANON}, ${ANON})`,
      // Both questions are already cast: the old path enqueued a reply cast for any text answer here.
      `INSERT INTO farcaster_casts (id, entity_type, entity_id, cast_hash, caster_fid) VALUES
         ('c1', 'query', '${Q_NAMED}', '0xabc123abc123', ${ME}),
         ('c2', 'query', '${Q_ANON}', '0xdef456def456', ${ANON})`,
    ]) await env.DB.prepare(sql).run();
    await (await attributionStatement(testEnv, { public_id: Q_ANON, fid: ME, type: 'question', scope_id: Q_ANON })).run();
    for (const [token, fid] of [[ME_TOKEN, ME], [OTHER_TOKEN, OTHER]] as const) {
      await env.KV_USER_PROFILES.put(`session:${token}`, JSON.stringify({ fid, expiresAt: Date.now() + 3_600_000 }));
    }
  });

  it('creating a question casts nothing unless the caller asks', () => {
    expect(resolveCastMode(undefined)).toBe('none');
    expect(resolveCastMode('client')).toBe('client');
    expect(resolveCastMode('server')).toBe('server');
    expect(resolveCastMode('bogus')).toBeNull();
  });

  it('saving a text answer on a cast question enqueues no reply cast', async () => {
    for (const audience of ['Public', 'Anon']) {
      const res = await handleCreateAnswer(new Request('http://x/api/answers', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q_id: Q_NAMED, value: `learned something (${audience})`, audience, user_id: ME, answer_type_id: 1 }),
      }), testEnv);
      expect(res.status).toBe(200);
    }
    expect(sent).toEqual([]);
  });

  it('tells the signed-in viewer whether they wrote the question', async () => {
    const isAuthor = async (id: string, token?: string) => {
      const res = await handleGetQuery(new Request(`http://x/api/queries/${id}`, { headers: bearer(token) }), testEnv, id);
      return ((await res.json()) as { viewer_is_author: boolean }).viewer_is_author;
    };
    expect(await isAuthor(Q_NAMED, ME_TOKEN)).toBe(true);
    expect(await isAuthor(Q_NAMED, OTHER_TOKEN)).toBe(false);
    expect(await isAuthor(Q_ANON, ME_TOKEN)).toBe(true); // through the sealed attribution
    expect(await isAuthor(Q_ANON, OTHER_TOKEN)).toBe(false);
    expect(await isAuthor(Q_NAMED)).toBe(false);
  });

  describe('@4n0n announces only its author\'s anon question', () => {
    const anonCast = async (body: Record<string, unknown>, token: string) => {
      const res = await handleFarcasterRoutes(new Request('http://x/api/farcaster/cast', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...bearer(token) },
        body: JSON.stringify({ useAnonBot: true, text: 'hello', ...body }),
      }), testEnv);
      return res!.status;
    };

    it('refuses a cast that names no question', async () => {
      expect(await anonCast({}, ME_TOKEN)).toBe(400);
    });
    it('refuses an unknown question', async () => {
      expect(await anonCast({ entityType: 'query', entityId: '33333333-3333-4333-8333-333333333333' }, ME_TOKEN)).toBe(404);
    });
    it('refuses a named question, even its own author', async () => {
      expect(await anonCast({ entityType: 'query', entityId: Q_NAMED }, ME_TOKEN)).toBe(403);
    });
    it('refuses someone else\'s anon question', async () => {
      expect(await anonCast({ entityType: 'query', entityId: Q_ANON }, OTHER_TOKEN)).toBe(403);
    });
  });
});
