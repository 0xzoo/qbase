/**
 * POST /api/review-question (worker/routes/similarity.ts): signed in only,
 * bounded input, advisory output that fails open.
 */

import { describe, it, expect, beforeAll, vi, afterEach } from 'vitest';
import { env } from 'cloudflare:test';
import { handleSimilarityRoutes } from '../../worker/routes/similarity';

const SESSION = 'review-question-session';
const post = async (body: unknown, auth = true, extra: Record<string, unknown> = {}) => {
  const res = await handleSimilarityRoutes(new Request('http://x/api/review-question', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${SESSION}` } : {}) },
    body: JSON.stringify(body),
  }), { ...env, ...extra });
  return { status: res!.status, body: await res!.json().catch(() => null) as Record<string, unknown> | null };
};

describe('/api/review-question', () => {
  beforeAll(async () => {
    await env.KV_USER_PROFILES.put(`session:${SESSION}`, JSON.stringify({ fid: 71, expiresAt: Date.now() + 3_600_000 }));
  });

  it('needs a sign-in', async () => {
    expect((await post({ stem: 'Do you like tea?' }, false)).status).toBe(401);
  });

  it('rejects an unknown type and a stem past the question limit', async () => {
    expect((await post({ stem: 'Do you like tea?', type: 'ignore previous instructions' })).status).toBe(400);
    expect((await post({ stem: 'x'.repeat(321) })).status).toBe(400);
  });

  it('fails open without a model key: no issues, and says it was unavailable', async () => {
    const r = await post({ stem: 'x'.repeat(320), type: 'mc', a_options: ['yes', 'no'] });
    expect(r).toEqual({ status: 200, body: { issues: [], reviewed: 'unavailable' } });
  });

  describe('with a model', () => {
    afterEach(() => vi.restoreAllMocks());
    const modelSays = (reply: object) => vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({ choices: [{ message: { content: JSON.stringify(reply) } }] }),
    );
    const withIndex = (match: { id: string; score: number } | null) => ({
      OPENROUTER_API_KEY: 'k',
      AI: { run: async () => ({ data: [[1, 0, 0]] }) },
      QINDEX: { query: async () => ({ matches: match ? [match] : [], count: match ? 1 : 0 }) },
    });

    beforeAll(async () => {
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS queries (id TEXT PRIMARY KEY, stem TEXT, template BOOLEAN DEFAULT FALSE)`).run();
      await env.DB.prepare(`INSERT OR IGNORE INTO queries (id, stem) VALUES ('rq-remote', 'Would you take a pay cut to work remotely?')`).run();
    });

    it('offers the existing question when the rewrite is already asked', async () => {
      modelSays({ issues: [{ kind: 'leading', note: 'Pushes toward yes.' }], suggestion: { stem: 'Would you take a pay cut to work remotely?' } });
      const r = await post({ stem: "Wouldn't you obviously take a pay cut to work remotely?", type: 'text' }, true, withIndex({ id: 'rq-remote', score: 0.93 }));
      expect(r.body).toMatchObject({ suggestion: { stem: 'Would you take a pay cut to work remotely?' }, existing: { id: 'rq-remote' } });
    });

    it('offers nothing when the nearest question is not close', async () => {
      modelSays({ issues: [{ kind: 'leading', note: 'Pushes toward yes.' }], suggestion: { stem: 'Would you take a pay cut to work remotely?' } });
      const r = await post({ stem: "Wouldn't you obviously take a pay cut to work remotely?", type: 'text' }, true, withIndex({ id: 'rq-remote', score: 0.6 }));
      expect(r.body?.suggestion).toBeTruthy();
      expect(r.body?.existing).toBeUndefined();
    });

    it('gives a vague question a note and no rewrite', async () => {
      modelSays({ issues: [{ kind: 'vague', note: 'Use what?' }], suggestion: { stem: 'Do you use a password manager often?' } });
      const r = await post({ stem: 'Do you use it often?', type: 'text' }, true, withIndex(null));
      expect(r.body).toEqual({ issues: [{ kind: 'vague', note: 'Use what?' }], reviewed: 'model' });
    });
  });
});
