/**
 * POST /api/farcaster/cast: bot casts need a signed-in requester.
 *
 * `usePollsBot: true` used to cast as @polls with no authentication at all,
 * and `useAnonBot: true` without a token skipped the anon score gate and the
 * daily limit (both ran only when a requester was known). Any caller could
 * post arbitrary text from either bot account.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { SELF, env } from 'cloudflare:test';

const TOKEN = 'web-session-token-for-bot-cast-test';
const FID = 7;

describe('bot casts require authentication', () => {
  beforeAll(async () => {
    await env.KV_USER_PROFILES.put(
      `session:${TOKEN}`,
      JSON.stringify({ fid: FID, expiresAt: Date.now() + 3_600_000 }),
    );
  });

  const post = (body: unknown, token?: string) =>
    SELF.fetch('https://example.com/api/farcaster/cast', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });

  it('refuses an unauthenticated @polls cast', async () => {
    const res = await post({ usePollsBot: true, text: 'hello', entityType: 'query', entityId: 'q1' });
    expect(res.status).toBe(401);
  });

  it('refuses an unauthenticated @4n0n cast', async () => {
    const res = await post({ useAnonBot: true, text: 'hello' });
    expect(res.status).toBe(401);
  });

  it('refuses an @polls cast that does not name a question', async () => {
    const res = await post({ usePollsBot: true, text: 'anything at all' }, TOKEN);
    expect(res.status).toBe(400);
  });
});
