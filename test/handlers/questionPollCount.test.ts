/**
 * The question payload says how many polls (waves) the question has run as,
 * so the page can show "2 past polls · see polls" without loading the list.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { handleGetQuery, handleListQueries } from '../../worker/handlers/queries';

describe('question payload carries poll_count', () => {
  beforeAll(async () => {
    const stmts = [
      `DROP TABLE IF EXISTS polls`,
      `CREATE TABLE IF NOT EXISTS queries (id TEXT PRIMARY KEY, stem TEXT NOT NULL, type TEXT NOT NULL, a_options TEXT, scale_config TEXT, date_config TEXT,
         created_at TEXT, coiner_id INTEGER, owner_id INTEGER, coiner_fname TEXT, coiner_fid INTEGER, tags TEXT, reqs TEXT, assets TEXT, parent TEXT,
         pub_answers INTEGER DEFAULT 0, priv_answers INTEGER DEFAULT 0, comments INTEGER DEFAULT 0, taxonomy TEXT, channel_id TEXT, casthash TEXT, token_id TEXT, cost INTEGER DEFAULT 0, template BOOLEAN DEFAULT FALSE)`,
      `CREATE TABLE IF NOT EXISTS farcaster_casts (id TEXT, entity_type TEXT, entity_id TEXT, cast_hash TEXT, cast_url TEXT, caster_fid INTEGER, cached_likes_count INTEGER, cached_recasts_count INTEGER, cached_replies_count INTEGER, stats_synced_at INTEGER)`,
      `CREATE TABLE IF NOT EXISTS farcaster_reactions (id TEXT, cast_hash TEXT, reactor_fid INTEGER, reaction_type TEXT, is_deleted INTEGER DEFAULT 0)`,
      `CREATE TABLE IF NOT EXISTS farcaster_replies (id TEXT, parent_cast_hash TEXT, is_active INTEGER DEFAULT 1)`,
      `CREATE TABLE IF NOT EXISTS question_meta (question_id TEXT PRIMARY KEY, forked_from TEXT)`,
      `CREATE TABLE polls (id TEXT PRIMARY KEY, question_id TEXT NOT NULL, closes_at TEXT NOT NULL, eligibility_gate TEXT, options_config TEXT, author_fid INTEGER, cast_hash TEXT, created_at TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'measure', channel_id TEXT)`,
      `CREATE TABLE IF NOT EXISTS poll_options (id TEXT PRIMARY KEY, poll_id TEXT, label TEXT, label_norm TEXT, source TEXT, created_by_fid INTEGER, created_at TEXT, hidden INTEGER DEFAULT 0)`,
      `INSERT OR IGNORE INTO queries (id, stem, type, created_at) VALUES ('q-polled', 'polled twice', 'mc', '2026-09-01'), ('q-never', 'never polled', 'mc', '2026-09-02')`,
      `INSERT INTO polls (id, question_id, closes_at, created_at) VALUES
         ('w1', 'q-polled', '2026-09-03T00:00:00.000Z', '2026-09-02T00:00:00.000Z'),
         ('w2', 'q-polled', '2026-09-10T00:00:00.000Z', '2026-09-09T00:00:00.000Z')`,
    ];
    for (const sql of stmts) await env.DB.prepare(sql).run();
  });

  it('on a single question', async () => {
    const polled = await (await handleGetQuery(new Request('http://x/api/queries/q-polled'), env, 'q-polled')).json() as { poll_count: number; current_poll?: unknown };
    expect(polled.poll_count).toBe(2);
    expect(polled.current_poll).toBeUndefined(); // both closed: no wave in play
    const never = await (await handleGetQuery(new Request('http://x/api/queries/q-never'), env, 'q-never')).json() as { poll_count: number };
    expect(never.poll_count).toBe(0);
  });

  it('in the question list', async () => {
    const list = await (await handleListQueries(new Request('http://x/api/queries?limit=10'), env)).json() as { results: Array<{ id: string; poll_count: number }> };
    const byId = Object.fromEntries(list.results.map(q => [q.id, q.poll_count]));
    expect(byId).toMatchObject({ 'q-polled': 2, 'q-never': 0 });
  });
});
