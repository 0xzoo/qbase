/**
 * POST /api/review-question (worker/routes/similarity.ts): signed in only,
 * bounded input, advisory output that fails open.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { handleSimilarityRoutes } from '../../worker/routes/similarity';

const SESSION = 'review-question-session';
const post = async (body: unknown, auth = true) => {
  const res = await handleSimilarityRoutes(new Request('http://x/api/review-question', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${SESSION}` } : {}) },
    body: JSON.stringify(body),
  }), { ...env });
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
});
