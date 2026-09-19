/**
 * Sticky audience per wave: the first tallied answer a person gives in a
 * wave decides whether their later answers there are public or anon.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { coerceTalliedAudience, resolveStickyAudience } from '../../worker/services/AudienceService';

const Q = 'q-sticky';
const W1 = 'wave-s1';
const W2 = 'wave-s2';

describe('AudienceService', () => {
  beforeAll(async () => {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS Answers (
         id TEXT PRIMARY KEY, q_id TEXT NOT NULL, user_id INTEGER NOT NULL, value TEXT,
         answer_type_id TEXT, answer_data TEXT, audience TEXT, created_at TEXT, poll_id TEXT)`,
    ).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS anon_attributions (id TEXT PRIMARY KEY, public_id TEXT NOT NULL UNIQUE, author_id INTEGER, author_tag TEXT, author_ct TEXT, type TEXT NOT NULL, created_at TEXT NOT NULL)`).run();
    const rows = [
      ['s1', Q, 1, 'A', 'Anon', '2026-09-01T00:00:01.000Z', W1],     // user 1: anon first in wave 1
      ['s2', Q, 1, 'B', 'Public', '2026-09-01T00:00:02.000Z', W1],   // ...then public (the leak case)
      ['s3', Q, 2, 'A', 'Public', '2026-09-01T00:00:03.000Z', W1],   // user 2: public first in wave 1
      ['s4', Q, 3, 'A', 'Private', '2026-09-01T00:00:04.000Z', W1],  // user 3: private only (not tallied)
      ['s5', Q, 1, 'C', 'Public', '2026-09-01T00:00:05.000Z', null], // user 1: direct answer, public
    ];
    for (const r of rows) {
      await env.DB.prepare(
        `INSERT OR IGNORE INTO Answers (id, q_id, user_id, value, answer_type_id, audience, created_at, poll_id)
         VALUES (?, ?, ?, ?, '2', ?, ?, ?)`,
      ).bind(...r).run();
    }
  });

  it('coerces anything but Anon to Public', () => {
    expect(coerceTalliedAudience('Anon')).toBe('Anon');
    expect(coerceTalliedAudience('Public')).toBe('Public');
    expect(coerceTalliedAudience('Private')).toBe('Public');
    expect(coerceTalliedAudience(undefined)).toBe('Public');
  });

  it('keeps the first tallied audience in a wave, whatever is requested', async () => {
    expect(await resolveStickyAudience(env.DB, Q, 1, W1, 'Public')).toEqual({ audience: 'Anon', sticky: true });
    expect(await resolveStickyAudience(env.DB, Q, 1, W1, 'Anon')).toEqual({ audience: 'Anon', sticky: true });
    expect(await resolveStickyAudience(env.DB, Q, 2, W1, 'Anon')).toEqual({ audience: 'Public', sticky: true });
  });

  it('is per wave: a fresh wave starts from the request', async () => {
    expect(await resolveStickyAudience(env.DB, Q, 1, W2, 'Public')).toEqual({ audience: 'Public', sticky: false });
    expect(await resolveStickyAudience(env.DB, Q, 1, W2, 'Anon')).toEqual({ audience: 'Anon', sticky: false });
  });

  it('direct answers are their own scope, and private rows do not count', async () => {
    expect(await resolveStickyAudience(env.DB, Q, 1, null, 'Anon')).toEqual({ audience: 'Public', sticky: true });
    expect(await resolveStickyAudience(env.DB, Q, 3, W1, 'Anon')).toEqual({ audience: 'Anon', sticky: false });
    expect(await resolveStickyAudience(env.DB, Q, 9, W1, 'Anon')).toEqual({ audience: 'Anon', sticky: false });
  });
});
