/**
 * Council routes — the unauthenticated surface and the config shape.
 */

import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';

describe('council routes', () => {
  it('GET /api/council/config is public and reports the gate state', async () => {
    const res = await SELF.fetch('http://localhost/api/council/config');
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({ stake_url: '/stake', models: ['qlaude', 'qemini', 'chatqpt'] });
    expect(typeof body.price).toBe('string');
    expect(typeof body.gated).toBe('boolean');
  });

  it('POST /api/queries/:id/council requires auth', async () => {
    const res = await SELF.fetch('http://localhost/api/queries/does-not-matter/council', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('GET /api/council/stake requires auth', async () => {
    const res = await SELF.fetch('http://localhost/api/council/stake');
    expect(res.status).toBe(401);
  });
});
