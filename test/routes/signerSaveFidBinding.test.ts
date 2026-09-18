/**
 * POST /api/farcaster/signer/save binds the signer row to the AUTHENTICATED fid
 * (audit 2026-09-08 §A, card t_a513dcbf).
 *
 * `body.fid` used to be written straight into `user_signers.fid`, so any
 * signed-in caller could re-point a signer row — including one belonging to
 * someone else — at an arbitrary FID. It is a cross-check now: a mismatch is a
 * 403 raised before the row is touched, which is why this asserts on the status
 * and never has to reason about D1 state.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { SELF, env } from 'cloudflare:test';

const TOKEN = 'web-session-token-for-signer-binding-test';
const FID = 7;

describe('signer/save binds to the authenticated FID', () => {
  beforeAll(async () => {
    await env.KV_USER_PROFILES.put(
      `session:${TOKEN}`,
      JSON.stringify({ fid: FID, expiresAt: Date.now() + 3_600_000 }),
    );
  });

  const post = (body: unknown, token?: string) =>
    SELF.fetch('https://example.com/api/farcaster/signer/save', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });

  it('rejects a body FID that differs from the authenticated FID', async () => {
    const res = await post({ signer_uuid: 'signer-uuid-under-test', fid: FID + 1 }, TOKEN);
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: 'fid_mismatch' });
  });

  it('answers 401 without a token', async () => {
    const res = await post({ signer_uuid: 'signer-uuid-under-test', fid: FID });
    expect(res.status).toBe(401);
  });

  it('answers 400 when signer_uuid is missing', async () => {
    const res = await post({ fid: FID }, TOKEN);
    expect(res.status).toBe(400);
  });
});
