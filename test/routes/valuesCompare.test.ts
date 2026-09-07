/**
 * /api/values/compare — the route's contract at the edges: a malformed or
 * missing id is 400, an unknown pair is 404, a single unknown id is 404,
 * /compare/me without a token is 401. The comparison itself is covered in
 * test/services/values/compare.test.ts.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { SELF, env } from 'cloudflare:test';

describe('GET /api/values/compare', () => {
  beforeAll(async () => {
    await env.DB.exec(
      "CREATE TABLE IF NOT EXISTS quiz_completions (id TEXT PRIMARY KEY, quiz_id TEXT NOT NULL, user_id INTEGER NOT NULL, completed_at INTEGER NOT NULL, answers_encrypted TEXT, answers_snapshot TEXT, scores TEXT, result_category TEXT, visibility TEXT NOT NULL DEFAULT 'private', created_at INTEGER NOT NULL, answers_materialized_at TEXT)"
    );
  });

  it('rejects a missing or malformed id', async () => {
    expect((await SELF.fetch('https://example.com/api/values/compare')).status).toBe(400);
    expect((await SELF.fetch('https://example.com/api/values/compare?a=nope')).status).toBe(400);
    expect((await SELF.fetch(`https://example.com/api/values/compare?a=${crypto.randomUUID()}&b=nope`)).status).toBe(400);
  });

  it('404s an unknown completion, alone or in a pair', async () => {
    const r1 = await SELF.fetch(`https://example.com/api/values/compare?a=${crypto.randomUUID()}`);
    expect(r1.status).toBe(404);
    const r2 = await SELF.fetch(`https://example.com/api/values/compare?a=${crypto.randomUUID()}&b=${crypto.randomUUID()}`);
    expect(r2.status).toBe(404);
  });

  it('needs a token for /compare/me', async () => {
    expect((await SELF.fetch('https://example.com/api/values/compare/me')).status).toBe(401);
  });
});
