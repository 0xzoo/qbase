/**
 * The anon tier sealed to Q (card t_9f2869db; migration 0072).
 *
 * Against local D1: an attribution carries a keyed per-question tag and the
 * FID in a SecretBox envelope, never a plaintext FID; ownership is a tag
 * comparison; tallies, dedup and the sticky rule treat an Anon row as one
 * person through its tag; a row without an attribution is nobody; and the
 * admin sweep moves legacy rows (FID on the row, FID in the attribution)
 * to the sealed shape and can put them back.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { anonTag, anonTagReady, anonPlaceholderFid, AnonTagNotReadyError } from '../../worker/services/anon/AnonTag';
import {
  attributionStatement, createAttribution, isAuthor, ownAnonAnswerIds, openAuthorFid, anonWriteFor,
} from '../../worker/services/AnonAttributionService';
import { getMcCounts, getExistingAnswer, getVoteChurn } from '../../worker/services/AnswerCountService';
import { resolveStickyAudience } from '../../worker/services/AudienceService';
import { handleAdminAnonSealMigrate } from '../../worker/routes/admin-anon-seal-migrate';

const K1 = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const TAG_KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const OTHER_TAG_KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const ANON = 514282;
const ADMIN = 'admin-secret';
const testEnv = (over: Record<string, unknown> = {}) => ({ DB: env.DB, ANSWER_KEKS: K1, ANON_TAG_KEY: TAG_KEY, ANON_FID: String(ANON), QBASE_ADMIN_SECRET: ADMIN, ...over });

const Q = 'q-anon';
const Q2 = 'q-anon-2';
const W = 'wave-a';

let seq = 0;
async function row(userId: number, value: string, opts: { audience?: string; poll?: string | null; q?: string; type?: number; completion?: string | null } = {}) {
  seq += 1;
  const id = `r-${seq}`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO Answers (id, q_id, user_id, value, answer_type_id, audience, created_at, poll_id, quiz_completion_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, opts.q ?? Q, userId, value, String(opts.type ?? 2), opts.audience ?? 'Public', `2026-09-01T00:00:${String(seq).padStart(2, '0')}.000Z`, opts.poll ?? null, opts.completion ?? null),
    env.DB.prepare(
      `INSERT INTO answer_meta (id, question_id, responder_fid, privacy_tier, primary_value, pending, created_at) VALUES (?, ?, ?, ?, ?, 0, 1)`,
    ).bind(id, opts.q ?? Q, userId, (opts.audience ?? 'Public').toLowerCase(), value),
  ]);
  return id;
}
/** A sealed-era Anon row: placeholder on the row, owned by `fid` through the tag. */
async function anonRow(fid: number, value: string, opts: { poll?: string | null; q?: string; type?: number } = {}) {
  const id = await row(ANON, value, { ...opts, audience: 'Anon' });
  await (await attributionStatement(testEnv(), { public_id: id, fid, type: 'answer', scope_id: opts.q ?? Q })).run();
  return id;
}
async function admin(body: Record<string, unknown>, e = testEnv()) {
  const res = await handleAdminAnonSealMigrate(new Request('http://x/api/admin/anon-seal-migrate', {
    method: 'POST', headers: { 'X-Admin-Secret': ADMIN, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }), e);
  return { status: res!.status, body: await res!.json() as Record<string, any> };
}

describe('anon tier sealed to Q', () => {
  beforeAll(async () => {
    await env.DB.batch([
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS Answers (id TEXT PRIMARY KEY, q_id TEXT NOT NULL, user_id INTEGER NOT NULL, value TEXT, answer_type_id TEXT, answer_data TEXT, audience TEXT, created_at TEXT, poll_id TEXT, quiz_completion_id TEXT)`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS answer_meta (id TEXT PRIMARY KEY, question_id TEXT NOT NULL, reply_cast_hash TEXT, replied_to_hash TEXT, responder_fid INTEGER, privacy_tier TEXT NOT NULL, storage_ref TEXT, primary_value TEXT, answer_index INTEGER, pending INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS anon_attributions (id TEXT PRIMARY KEY, public_id TEXT NOT NULL UNIQUE, author_id INTEGER, author_tag TEXT, author_ct TEXT, type TEXT NOT NULL, created_at TEXT NOT NULL)`),
    ]);
  });
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM Answers'), env.DB.prepare('DELETE FROM answer_meta'), env.DB.prepare('DELETE FROM anon_attributions'),
    ]);
  });

  it('tags are keyed, per person and per question, and refuse to run without a key', async () => {
    const t = await anonTag(testEnv(), 42, Q);
    expect(t).toMatch(/^[0-9a-f]{64}$/);
    expect(await anonTag(testEnv(), 42, Q)).toBe(t);
    expect(await anonTag(testEnv(), 43, Q)).not.toBe(t);
    expect(await anonTag(testEnv(), 42, Q2)).not.toBe(t);            // one person, two questions: unrelated
    expect(await anonTag(testEnv({ ANON_TAG_KEY: OTHER_TAG_KEY }), 42, Q)).not.toBe(t);
    await expect(anonTag(testEnv({ ANON_TAG_KEY: undefined }), 42, Q)).rejects.toBeInstanceOf(AnonTagNotReadyError);
    await expect(anonTag(testEnv({ ANON_TAG_KEY: 'short' }), 42, Q)).rejects.toBeInstanceOf(AnonTagNotReadyError);
    expect(await anonTagReady(testEnv())).toBe(true);
    expect(await anonTagReady(testEnv({ ANON_TAG_KEY: '' }))).toBe(false);
    expect(anonPlaceholderFid(testEnv())).toBe(ANON);
    expect(anonPlaceholderFid({})).toBe(514282);
  });

  it('an attribution holds a tag and an envelope, never a plaintext FID; ownership is a tag comparison', async () => {
    const id = await row(ANON, 'A', { audience: 'Anon' });
    await createAttribution(testEnv(), { public_id: id, fid: 42, type: 'answer', scope_id: Q });
    const stored = await env.DB.prepare('SELECT author_id, author_tag, author_ct, type FROM anon_attributions WHERE public_id = ?').bind(id).first() as Record<string, unknown>;
    expect(stored.author_id).toBeNull();
    expect(stored.author_tag).toBe(await anonTag(testEnv(), 42, Q));
    const envelope = JSON.parse(String(stored.author_ct));
    expect(envelope).toMatchObject({ qenc: 1, ctx: `anon_attributions:${id}|anon|0` });
    expect(atob(envelope.ct)).not.toBe('42'); // ciphertext + tag, not the FID
    expect(await isAuthor(testEnv(), id, 42, Q)).toBe(true);
    expect(await isAuthor(testEnv(), id, 42, Q, 'answer')).toBe(true);
    expect(await isAuthor(testEnv(), id, 42, Q, 'question')).toBe(false);
    expect(await isAuthor(testEnv(), id, 43, Q)).toBe(false);
    expect(await isAuthor(testEnv(), id, 42, Q2)).toBe(false);
    expect(await isAuthor(testEnv(), 'nope', 42, Q)).toBe(false);
    // the operator path opens the envelope; a wrong KEK cannot
    expect(await openAuthorFid(testEnv(), id)).toBe(42);
    await expect(openAuthorFid(testEnv({ ANSWER_KEKS: OTHER_TAG_KEY }), id)).rejects.toThrow();
    // re-attributing the same row replaces, never duplicates
    await createAttribution(testEnv(), { public_id: id, fid: 43, type: 'answer', scope_id: Q });
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM anon_attributions WHERE public_id = ?').bind(id).first())).toEqual({ n: 1 });
    expect(await isAuthor(testEnv(), id, 43, Q)).toBe(true);
    expect(await isAuthor(testEnv(), id, 42, Q)).toBe(false);
  });

  it('a legacy attribution (plaintext author_id) still answers ownership until the sweep runs', async () => {
    const id = await row(42, 'A', { audience: 'Anon' });
    await env.DB.prepare("INSERT INTO anon_attributions (id, public_id, author_id, type, created_at) VALUES ('l1', ?, 42, 'answer', '2026-01-01')").bind(id).run();
    expect(await isAuthor(testEnv(), id, 42, Q)).toBe(true);
    expect(await isAuthor(testEnv(), id, 43, Q)).toBe(false);
    expect(await openAuthorFid(testEnv(), id)).toBe(42);
    expect([...await ownAnonAnswerIds(testEnv(), 42, [Q])]).toEqual([id]);
  });

  it('ownAnonAnswerIds finds the requester\'s anon rows on the questions at hand and nothing else', async () => {
    const a = await anonRow(42, 'A');
    const b = await anonRow(42, 'B', { q: Q2 });
    const c = await anonRow(43, 'C');
    await row(42, 'D'); // a named row is not an anon row
    expect([...await ownAnonAnswerIds(testEnv(), 42, [Q, Q2])].sort()).toEqual([a, b].sort());
    expect([...await ownAnonAnswerIds(testEnv(), 42, [Q])]).toEqual([a]);
    expect([...await ownAnonAnswerIds(testEnv(), 42, [Q, Q, undefined as never, ''])]).toEqual([a]);
    expect([...await ownAnonAnswerIds(testEnv(), 43, [Q, Q2])]).toEqual([c]);
    expect([...await ownAnonAnswerIds(testEnv(), 44, [Q, Q2])]).toEqual([]);
    expect([...await ownAnonAnswerIds(testEnv(), 42, [])]).toEqual([]);
    // 200 questions: more than one IN chunk
    const many = Array.from({ length: 200 }, (_, i) => `q-many-${i}`);
    expect([...await ownAnonAnswerIds(testEnv(), 42, [...many, Q])]).toEqual([a]);
  });

  it('anonWriteFor: a named row keeps the FID; an Anon row gets the placeholder and a batched attribution', async () => {
    const named = await anonWriteFor(testEnv(), { fid: 42, audience: 'Public', answerId: 'x', qId: Q });
    expect(named).toEqual({ rowFid: 42, statement: null });
    const anon = await anonWriteFor(testEnv(), { fid: 42, audience: 'Anon', answerId: 'y', qId: Q });
    expect(anon.rowFid).toBe(ANON);
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO Answers (id, q_id, user_id, value, answer_type_id, audience, created_at) VALUES ('y', ?, ?, 'A', '2', 'Anon', '2026-09-01')`).bind(Q, anon.rowFid),
      anon.statement,
    ]);
    expect(await isAuthor(testEnv(), 'y', 42, Q)).toBe(true);
    // no key → the write refuses rather than storing an unowned anon row
    await expect(anonWriteFor(testEnv({ ANON_TAG_KEY: undefined }), { fid: 42, audience: 'Anon', answerId: 'z', qId: Q })).rejects.toBeInstanceOf(AnonTagNotReadyError);
  });

  it('tallies: each attributed Anon row is one person; the same person\'s rows collapse; unattributed placeholder rows are one bucket', async () => {
    await anonRow(42, 'A', { poll: W });
    await anonRow(43, 'A', { poll: W });
    await anonRow(44, 'B', { poll: W });
    await anonRow(42, 'B', { poll: W });          // 42 flips: latest wins
    await row(1, 'A', { poll: W });
    await row(ANON, 'C', { audience: 'Anon', poll: W }); // no attribution: nobody in particular
    await row(ANON, 'C', { audience: 'Anon', poll: W }); // …and both such rows are one bucket
    const { counts, total } = await getMcCounts(env.DB, Q, W);
    expect(counts).toEqual({ A: 2, B: 2, C: 1 }); // 43→A, 1→A, 42→B, 44→B, placeholder→C
    expect(total).toBe(5);
    const { churn, changes } = await getVoteChurn(env.DB, W, 2, [3, ANON]);
    expect(churn).toEqual({ changed_voters: 1, total_changes: 1 }); // 42's anon flip counts; public log stays empty
    expect(changes).toEqual([]);
  });

  it('dedup and the sticky rule reach a person\'s Anon rows through the tag, not user_id', async () => {
    const a = await anonRow(42, 'A', { poll: W });
    const tag42 = await anonTag(testEnv(), 42, Q);
    const tag43 = await anonTag(testEnv(), 43, Q);
    expect((await getExistingAnswer(env.DB, Q, 42, 2, W, tag42))?.id).toBe(a);
    expect(await getExistingAnswer(env.DB, Q, 42, 2, W)).toBeNull();          // without the tag the row is nobody's
    expect(await getExistingAnswer(env.DB, Q, 43, 2, W, tag43)).toBeNull();
    expect(await resolveStickyAudience(env.DB, Q, 42, W, 'Public', tag42)).toEqual({ audience: 'Anon', sticky: true });
    expect(await resolveStickyAudience(env.DB, Q, 43, W, 'Public', tag43)).toEqual({ audience: 'Public', sticky: false });
    expect(await resolveStickyAudience(env.DB, Q, 42, null, 'Public', tag42)).toEqual({ audience: 'Public', sticky: false }); // per scope
  });

  it('the sweep seals legacy rows: FID off the row and the meta, attribution tagged and enveloped, completion unlinked; unseal puts author_id back', async () => {
    // pre-sweep shapes: real FID on the Anon row (most rows), the old placeholder 3, a legacy attribution row, an anon question
    const r1 = await row(42, 'A', { audience: 'Anon', completion: 'c-42' });
    const r2 = await row(43, 'B', { audience: 'Anon', poll: W });
    const r3 = await row(3, 'C', { audience: 'Anon' });
    const r4 = await row(42, 'D', { audience: 'Anon', q: Q2 });
    await env.DB.prepare("INSERT INTO anon_attributions (id, public_id, author_id, type, created_at) VALUES ('l4', ?, 42, 'answer', '2026-01-01')").bind(r4).run();
    await env.DB.prepare("INSERT INTO anon_attributions (id, public_id, author_id, type, created_at) VALUES ('lq', 'anon-question-1', 44, 'question', '2026-01-01')").run();
    await env.DB.prepare("INSERT INTO anon_attributions (id, public_id, author_id, type, created_at) VALUES ('lgone', 'answer-deleted', 45, 'answer', '2026-01-01')").run();
    await row(7, 'P'); // a Public row is untouched

    const before = await admin({ phase: 'status' });
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ anon_rows_with_author: 3, anon_rows_legacy_placeholder: 1, anon_rows_linked_to_completion: 1, attributions_legacy: 3, attributions_sealed: 0, anon_rows_total: 4, tag_key_ready: true, kek_ready: true });

    const dry = await admin({ phase: 'answers', dryRun: true });
    expect(dry.body).toMatchObject({ processed: 4, sealed: 3, rewritten: 4, errors: [], done: true });
    expect((await admin({ phase: 'status' })).body).toMatchObject({ anon_rows_with_author: 3 }); // nothing written

    const answers = await admin({ phase: 'answers', limit: 3 });
    expect(answers.body).toMatchObject({ processed: 3, errors: [], done: false });
    const answers2 = await admin({ phase: 'answers', limit: 3 });
    expect(answers2.body).toMatchObject({ processed: 1, errors: [], done: true });
    const attrs = await admin({ phase: 'attributions' });
    // r4's legacy row was already sealed by the answers phase (upsert); the question and the orphan remain
    expect(attrs.body).toMatchObject({ processed: 2, sealed: 1, deleted: 1, errors: [], done: true });

    const after = await admin({ phase: 'status' });
    expect(after.body).toMatchObject({ anon_rows_with_author: 0, anon_rows_legacy_placeholder: 0, anon_rows_linked_to_completion: 0, anon_meta_with_author: 0, attributions_legacy: 0, attributions_sealed: 4, attributions_total: 4 });

    for (const [id, fid, q] of [[r1, 42, Q], [r2, 43, Q], [r4, 42, Q2]] as Array<[string, number, string]>) {
      expect(await env.DB.prepare('SELECT user_id, quiz_completion_id FROM Answers WHERE id = ?').bind(id).first()).toEqual({ user_id: ANON, quiz_completion_id: null });
      expect(await env.DB.prepare('SELECT responder_fid FROM answer_meta WHERE id = ?').bind(id).first()).toEqual({ responder_fid: ANON });
      expect(await isAuthor(testEnv(), id, fid, q, 'answer')).toBe(true);
      expect(await openAuthorFid(testEnv(), id)).toBe(fid);
    }
    expect(await env.DB.prepare('SELECT user_id FROM Answers WHERE id = ?').bind(r3).first()).toEqual({ user_id: ANON });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM anon_attributions WHERE public_id = ?').bind(r3).first()).toEqual({ n: 0 });
    expect(await isAuthor(testEnv(), 'anon-question-1', 44, 'anon-question-1', 'question')).toBe(true);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM anon_attributions WHERE public_id = 'answer-deleted'").first()).toEqual({ n: 0 });
    expect(await env.DB.prepare('SELECT user_id FROM Answers WHERE value = ?').bind('P').first()).toEqual({ user_id: 7 });
    // no plaintext FID survives anywhere in the attribution table
    const cols = (await env.DB.prepare('SELECT author_id, author_tag, author_ct FROM anon_attributions').all()).results as Array<Record<string, unknown>>;
    expect(cols.every((c) => c.author_id === null && c.author_tag && c.author_ct)).toBe(true);
    // the tally still sees four people on Q: 42, 43, the Public row's 7, and the unattributed legacy row as one bucket
    expect((await getMcCounts(env.DB, Q)).total).toBe(4);

    // rollback: author_id restored from the envelopes
    const unseal = await admin({ phase: 'unseal' });
    expect(unseal.body).toMatchObject({ processed: 4, rewritten: 4, errors: [], done: true });
    expect(await env.DB.prepare('SELECT author_id FROM anon_attributions WHERE public_id = ?').bind(r2).first()).toEqual({ author_id: 43 });
    expect((await admin({ phase: 'status' })).body).toMatchObject({ attributions_legacy: 4 });
  });

  it('the sweep refuses without the admin secret or the keys', async () => {
    const res = await handleAdminAnonSealMigrate(new Request('http://x/api/admin/anon-seal-migrate', { method: 'POST', body: '{}' }), testEnv());
    expect(res!.status).toBe(403);
    expect((await admin({ phase: 'answers' }, testEnv({ ANON_TAG_KEY: undefined }))).status).toBe(503);
    expect((await admin({ phase: 'answers' }, testEnv({ ANSWER_KEKS: undefined }))).status).toBe(503);
    expect((await admin({ phase: 'bogus' })).status).toBe(400);
    expect(await handleAdminAnonSealMigrate(new Request('http://x/api/other', { method: 'POST' }), testEnv())).toBeNull();
  });
});
