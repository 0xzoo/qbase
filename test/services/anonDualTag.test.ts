/**
 * Anon ownership across the account cutover (docs/specs/account-root.md §5).
 *
 * Between the `rewrite` phase and the `retag` sweep, callers pass account ids
 * while attribution tags are still HMAC over the legacy key (the fid). An
 * account whose `legacy_key` is that fid owns the row; any other account does
 * not.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { anonTag } from '../../worker/services/anon/AnonTag';
import {
  attributionStatement, authorTags, isAuthor, ownAnonAnswerIds, ownRowsBinds,
} from '../../worker/services/AnonAttributionService';
import { getExistingAnswer } from '../../worker/services/AnswerCountService';
import { resolveStickyAudience } from '../../worker/services/AudienceService';

const K1 = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const TAG_KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const ANON = 514282;
const testEnv = () => ({ DB: env.DB, ANSWER_KEKS: K1, ANON_TAG_KEY: TAG_KEY, ANON_FID: String(ANON) });

const Q = 'q-dual';
const FID = 42;
const WITH_LEGACY = 2 ** 40 + 1001;    // legacy_key = FID
const WITHOUT_LEGACY = 2 ** 40 + 1002; // legacy_key NULL
const OTHER_LEGACY = 2 ** 40 + 1003;   // legacy_key = 43

async function anonRow(id: string, taggedOver: number) {
  await env.DB.prepare(
    `INSERT INTO Answers (id, q_id, user_id, value, answer_type_id, audience, created_at, poll_id)
     VALUES (?, ?, ?, 'A', '2', 'Anon', '2026-09-01T00:00:00.000Z', NULL)`,
  ).bind(id, Q, ANON).run();
  await (await attributionStatement(testEnv(), { public_id: id, fid: taggedOver, type: 'answer', scope_id: Q })).run();
}

describe('anon ownership: dual tags during the account cutover', () => {
  beforeAll(async () => {
    await env.DB.batch([
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS Answers (id TEXT PRIMARY KEY, q_id TEXT NOT NULL, user_id INTEGER NOT NULL, value TEXT, answer_type_id TEXT, answer_data TEXT, audience TEXT, created_at TEXT, poll_id TEXT, quiz_completion_id TEXT)`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS anon_attributions (id TEXT PRIMARY KEY, public_id TEXT NOT NULL UNIQUE, author_id INTEGER, author_tag TEXT, author_ct TEXT, type TEXT NOT NULL, created_at TEXT NOT NULL)`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS accounts (id INTEGER PRIMARY KEY, born_from TEXT NOT NULL, legacy_key INTEGER UNIQUE, created_at INTEGER NOT NULL)`),
    ]);
  });
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM Answers'),
      env.DB.prepare('DELETE FROM anon_attributions'),
      env.DB.prepare('DELETE FROM accounts WHERE id IN (?, ?, ?)').bind(WITH_LEGACY, WITHOUT_LEGACY, OTHER_LEGACY),
    ]);
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO accounts (id, born_from, legacy_key, created_at) VALUES (?, 'farcaster', ?, 1)`).bind(WITH_LEGACY, FID),
      env.DB.prepare(`INSERT INTO accounts (id, born_from, legacy_key, created_at) VALUES (?, 'ethereum', NULL, 1)`).bind(WITHOUT_LEGACY),
      env.DB.prepare(`INSERT INTO accounts (id, born_from, legacy_key, created_at) VALUES (?, 'farcaster', 43, 1)`).bind(OTHER_LEGACY),
    ]);
  });

  it('authorTags: the account tag, plus the legacy-key tag when the account has one', async () => {
    expect(await authorTags(testEnv(), WITH_LEGACY, Q)).toEqual([
      await anonTag(testEnv(), WITH_LEGACY, Q),
      await anonTag(testEnv(), FID, Q),
    ]);
    expect(await authorTags(testEnv(), WITHOUT_LEGACY, Q)).toEqual([await anonTag(testEnv(), WITHOUT_LEGACY, Q)]);
    expect(await authorTags(testEnv(), FID, Q)).toEqual([await anonTag(testEnv(), FID, Q)]); // a fid is not an account id
    expect(ownRowsBinds(7, ['a'])).toEqual([7, 'a', 'a']);
    expect(ownRowsBinds(7, ['a', 'b'])).toEqual([7, 'a', 'b']);
    expect(ownRowsBinds(7, null)).toEqual([7, '', '']);
  });

  it('a tag over the legacy key is accepted for the account whose legacy_key it is', async () => {
    await anonRow('r-legacy', FID);
    expect(await isAuthor(testEnv(), 'r-legacy', WITH_LEGACY, Q, 'answer')).toBe(true);
    expect(await isAuthor(testEnv(), 'r-legacy', FID, Q, 'answer')).toBe(true); // the fid itself, as before
    expect([...await ownAnonAnswerIds(testEnv(), WITH_LEGACY, [Q])]).toEqual(['r-legacy']);
    const tags = await authorTags(testEnv(), WITH_LEGACY, Q);
    expect((await getExistingAnswer(env.DB, Q, WITH_LEGACY, 2, null, tags))?.id).toBe('r-legacy');
    expect(await resolveStickyAudience(env.DB, Q, WITH_LEGACY, null, 'Public', tags)).toEqual({ audience: 'Anon', sticky: true });
  });

  it('a tag over the legacy key is not accepted for an account without it', async () => {
    await anonRow('r-legacy', FID);
    for (const acct of [WITHOUT_LEGACY, OTHER_LEGACY]) {
      expect(await isAuthor(testEnv(), 'r-legacy', acct, Q, 'answer')).toBe(false);
      expect([...await ownAnonAnswerIds(testEnv(), acct, [Q])]).toEqual([]);
      const tags = await authorTags(testEnv(), acct, Q);
      expect(await getExistingAnswer(env.DB, Q, acct, 2, null, tags)).toBeNull();
      expect(await resolveStickyAudience(env.DB, Q, acct, null, 'Public', tags)).toEqual({ audience: 'Public', sticky: false });
    }
  });

  it('a tag over the account id (after retag) is the account\'s, and not the bare fid\'s', async () => {
    await anonRow('r-retagged', WITH_LEGACY);
    expect(await isAuthor(testEnv(), 'r-retagged', WITH_LEGACY, Q, 'answer')).toBe(true);
    expect(await isAuthor(testEnv(), 'r-retagged', FID, Q, 'answer')).toBe(false);
    expect(await isAuthor(testEnv(), 'r-retagged', WITHOUT_LEGACY, Q, 'answer')).toBe(false);
    expect([...await ownAnonAnswerIds(testEnv(), WITH_LEGACY, [Q])]).toEqual(['r-retagged']);
  });
});
