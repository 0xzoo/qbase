/**
 * The quiz session routes accept the web session token as well as a Quick
 * Auth JWT (audit 2026-09-08 §0.1, card t_3f54bf4c). A browser taker lands on
 * the result page with the session token; a 401 from these routes is turned
 * into a logout by `apiClient`. With a valid session token and an unknown sid
 * every route answers 404 — the token was accepted and the lookup ran.
 * Without a token, or with a token that is neither a JWT nor a session, 401.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { SELF, env } from 'cloudflare:test';

const TOKEN = 'web-session-token-for-tests';

const ROUTES: Array<[string, string]> = [
  ['GET', '/api/values/session?sid=nope'],
  ['GET', '/api/values/dim-narratives?sid=nope'],
  ['GET', '/api/values/export?sid=nope'],
  ['GET', '/api/apperception/session?sid=nope'],
  ['POST', '/api/apperception/rate?sid=nope'],
  ['GET', '/api/apperception/dim-narratives?sid=nope'],
];

describe('quiz session routes take the web session token', () => {
  beforeAll(async () => {
    await env.KV_USER_PROFILES.put(
      `session:${TOKEN}`,
      JSON.stringify({ fid: 7, expiresAt: Date.now() + 3_600_000 }),
    );
  });

  for (const [method, path] of ROUTES) {
    it(`${method} ${path}: 404 with a session token, 401 without`, async () => {
      const accepted = await SELF.fetch(`https://example.com${path}`, {
        method,
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      expect(accepted.status).toBe(404);

      const missing = await SELF.fetch(`https://example.com${path}`, { method });
      expect(missing.status).toBe(401);

      const bogus = await SELF.fetch(`https://example.com${path}`, {
        method,
        headers: { Authorization: 'Bearer neither-a-jwt-nor-a-session' },
      });
      expect(bogus.status).toBe(401);
    });
  }
});
