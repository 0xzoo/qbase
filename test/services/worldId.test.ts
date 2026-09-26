/**
 * Verified-human answering on world_id waves (plan §5.4).
 *
 * World's verify API is mocked (a fetch stub); everything else runs against
 * the pool's local D1: the gate, the nullifier table from migration 0073 and
 * the ordinary answer create path.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { privateKeyToAccount } from 'viem/accounts';
import { recoverMessageAddress } from 'viem';
import { computeRpSignatureMessage } from '@worldcoin/idkit-core/signing';
import { hashSignal } from '@worldcoin/idkit-core/hashing';
import migration from '../../migrations/0073_world_verifications.sql?raw';
import accountsMigration from '../../migrations/0076_accounts.sql?raw';
import { EligibilityService } from '../../worker/services/EligibilityService';
import { insertPoll, type PollRow } from '../../worker/services/PollService';
import { validateGateSubmission, resolveGate } from '../../worker/services/WaveService';
import {
  normalizeNullifier, signRpContext, verifyProof, worldAction, worldConfig, WORLD_VERIFY_BASE, type WorldConfig,
} from '../../worker/services/WorldIdService';
import { answerWithWorldProof } from '../../worker/routes/polls-world';

// World's own test key and vectors (worldcoin/idkit js/packages/server/src/__tests__/signing.test.ts).
const TEST_KEY = '0xabababababababababababababababababababababababababababababababab';
const CFG: WorldConfig = { appId: 'app_staging_test', rpId: 'rp_test', environment: 'sandbox', signingKey: TEST_KEY };
const TAG_KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const FUTURE = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
const PAST = new Date(Date.now() - 3600 * 1000).toISOString();
const Q = '11111111-1111-4111-8111-111111111111';
const WORLD_GATE = JSON.stringify({ type: 'world_id', credential: 'proof_of_human' });

// Two distinct 78-digit nullifiers that collide once squeezed through a REAL.
const N1 = '0x' + 'f'.repeat(63) + 'e';
const N2 = '0x' + 'f'.repeat(63) + 'd';

const testEnv = () => ({
  DB: env.DB,
  KV_USER_POINTS: env.KV_USER_POINTS,
  KV_USER_PROFILES: env.KV_USER_PROFILES,
  ANON_TAG_KEY: TAG_KEY,
  ANON_FID: '514282',
});

function idkitResult(pollId: string, over: Record<string, unknown> = {}) {
  return {
    protocol_version: '4.0',
    nonce: '0x01',
    action: worldAction(pollId),
    environment: 'sandbox',
    responses: [{ identifier: 'proof_of_human', proof: ['0x1', '0x2', '0x3', '0x4', '0x5'], nullifier: N1, issuer_schema_id: 1, expires_at_min: 0 }],
    ...over,
  };
}

/** A World verify API that answers with this nullifier; records what it was sent. */
function worldApi(nullifier: string, over: Record<string, unknown> = {}, status = 200) {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init?.body)) });
    const action = (JSON.parse(String(init?.body)) as { action: string }).action;
    return Response.json(
      status === 200
        ? { success: true, action, nullifier, environment: 'sandbox', created_at: new Date().toISOString(), results: [], ...over }
        : { success: false, code: 'all_verifications_failed', detail: 'bad proof', ...over },
      { status },
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

async function worldWave(closesAt = FUTURE): Promise<PollRow> {
  return insertPoll(env.DB, { question_id: Q, closes_at: closesAt, eligibility_gate: WORLD_GATE });
}

const MC = { value: 'Yes', answer_type_id: 2, audience: 'Public' };

async function answers(pollId: string) {
  const { results } = await env.DB.prepare('SELECT user_id, value FROM Answers WHERE poll_id = ? ORDER BY created_at').bind(pollId).all();
  return results as Array<{ user_id: number; value: string }>;
}
async function nullifiers(pollId: string) {
  const { results } = await env.DB.prepare('SELECT * FROM world_verifications WHERE poll_id = ?').bind(pollId).all();
  return results as Array<Record<string, unknown>>;
}

describe('World ID verified-human waves', () => {
  beforeAll(async () => {
    const stmts = [
      `CREATE TABLE IF NOT EXISTS queries (id TEXT PRIMARY KEY, stem TEXT, type TEXT, a_options TEXT, taxonomy TEXT, coiner_fid INTEGER, owner_id INTEGER, pub_answers INTEGER DEFAULT 0, priv_answers INTEGER DEFAULT 0)`,
      `CREATE TABLE IF NOT EXISTS question_meta (question_id TEXT PRIMARY KEY, cast_hash TEXT, author_fid INTEGER)`,
      `CREATE TABLE IF NOT EXISTS farcaster_casts (entity_type TEXT, entity_id TEXT, cast_hash TEXT, caster_fid INTEGER)`,
      `CREATE TABLE IF NOT EXISTS users (fid INTEGER PRIMARY KEY, fname TEXT)`,
      `CREATE TABLE IF NOT EXISTS polls (id TEXT PRIMARY KEY, question_id TEXT NOT NULL, closes_at TEXT NOT NULL, eligibility_gate TEXT, options_config TEXT, author_fid INTEGER, cast_hash TEXT, channel_id TEXT, kind TEXT NOT NULL DEFAULT 'measure', created_at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS Answers (id TEXT PRIMARY KEY, q_id TEXT NOT NULL, user_id INTEGER NOT NULL, value TEXT, answer_type_id TEXT, answer_data TEXT, audience TEXT, created_at TEXT, primary_type TEXT, reasoning TEXT, topics TEXT, storage_ref TEXT, poll_id TEXT, quiz_completion_id TEXT)`,
      `CREATE TABLE IF NOT EXISTS answer_meta (id TEXT PRIMARY KEY, question_id TEXT NOT NULL, reply_cast_hash TEXT, replied_to_hash TEXT, responder_fid INTEGER, privacy_tier TEXT NOT NULL, storage_ref TEXT, primary_value TEXT, answer_index INTEGER, pending INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS anon_attributions (id TEXT PRIMARY KEY, public_id TEXT NOT NULL UNIQUE, author_id INTEGER, author_tag TEXT, author_ct TEXT, type TEXT NOT NULL, created_at TEXT NOT NULL)`,
    ];
    await env.DB.batch(stmts.map(s => env.DB.prepare(s)));
    // The real migration, not a copy of it.
    for (const [table, file] of [['world_verifications', migration], ['account_credentials', accountsMigration]] as const) {
      const exists = await env.DB.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').bind(table).first();
      if (!exists) {
        const sql = file.replace(/--.*$/gm, '');
        await env.DB.batch(sql.split(';').map(s => s.trim()).filter(Boolean).map(s => env.DB.prepare(s)));
      }
    }
  });

  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM Answers'), env.DB.prepare('DELETE FROM answer_meta'), env.DB.prepare('DELETE FROM polls'),
      env.DB.prepare('DELETE FROM world_verifications'), env.DB.prepare('DELETE FROM users'), env.DB.prepare('DELETE FROM queries'),
      env.DB.prepare("INSERT INTO queries (id, stem, type, a_options, coiner_fid) VALUES (?, 'Q?', 'mc', '[\"Yes\",\"No\"]', 1)").bind(Q),
      env.DB.prepare('INSERT INTO users (fid, fname) VALUES (7, ?), (8, ?)').bind('alice', 'alice-alt'),
    ]);
  });

  describe('RP signature', () => {
    it('hashes with Keccak-256 (World vector), not SHA3', () => {
      expect(hashSignal('test_signal')).toBe('0x00c1636e0a961a3045054c4d61374422c31a95846b8442f0927ad2ff1d6112ed');
      expect(hashSignal('')).toBe('0x00c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a4');
    });

    it('signs the wave action; the signature recovers to the RP key', async () => {
      const ctx = signRpContext(CFG, 'wave-1');
      expect(ctx).toMatchObject({ app_id: CFG.appId, action: 'qbase-wave-wave-1', environment: 'sandbox' });
      expect(ctx.rp_context.rp_id).toBe(CFG.rpId);
      expect(ctx.rp_context.expires_at - ctx.rp_context.created_at).toBe(300);
      const nonce = Uint8Array.from(ctx.rp_context.nonce.slice(2).match(/../g)!.map(h => parseInt(h, 16)));
      const message = computeRpSignatureMessage(nonce, ctx.rp_context.created_at, ctx.rp_context.expires_at, ctx.action);
      expect(message.length).toBe(81); // action appended: uniqueness proof, not a session
      const signer = await recoverMessageAddress({ message: { raw: message }, signature: ctx.rp_context.signature as `0x${string}` });
      expect(signer).toBe(privateKeyToAccount(TEST_KEY).address);
    });

    it('is inert without config', () => {
      expect(worldConfig({})).toBeNull();
      expect(worldConfig({ WORLD_APP_ID: 'a', WORLD_RP_ID: 'r', WORLD_RP_SIGNING_KEY: 'k', WORLD_ENVIRONMENT: 'prod' })).toBeNull();
      expect(worldConfig({ WORLD_APP_ID: 'a', WORLD_RP_ID: 'r', WORLD_RP_SIGNING_KEY: 'k', WORLD_ENVIRONMENT: 'sandbox' })).not.toBeNull();
      const base = { WORLD_APP_ID: 'a', WORLD_RP_ID: 'r', WORLD_RP_SIGNING_KEY: 'k', WORLD_STAGING_VERIFICATION_TOKEN: 't' };
      expect(worldConfig({ ...base, WORLD_ENVIRONMENT: 'sandbox' })?.stagingToken).toBe('t');
      expect(worldConfig({ ...base, WORLD_ENVIRONMENT: 'production' })?.stagingToken).toBeUndefined();
    });
  });

  describe('gate', () => {
    it('validates and resolves without a snapshot', async () => {
      expect(validateGateSubmission({ type: 'world_id', credential: 'proof_of_human' })).toBeNull();
      expect(validateGateSubmission({ type: 'world_id', credential: 'passport' })).toMatchObject({ code: 'gate_invalid' });
      expect(await resolveGate(testEnv(), { type: 'world_id', credential: 'proof_of_human' }))
        .toEqual({ gate: { type: 'world_id', credential: 'proof_of_human' } });
    });

    it('not_verified without a proof; open with one; closed first', async () => {
      const poll = await worldWave();
      expect(await EligibilityService.check(testEnv(), poll, 7)).toMatchObject({ eligible: false, reason: 'not_verified' });
      expect(await EligibilityService.check(testEnv(), poll, 7, { worldVerified: true })).toMatchObject({ eligible: true, reason: 'open' });
      const closed = await worldWave(PAST);
      expect(await EligibilityService.check(testEnv(), closed, 7, { worldVerified: true })).toMatchObject({ reason: 'closed' });
    });

    it('a prior answer lets the account re-answer, but a public probe never sees it', async () => {
      const poll = await worldWave();
      const { fetchImpl } = worldApi(N1);
      await answerWithWorldProof(testEnv(), CFG, poll, 7, MC, idkitResult(poll.id), false, fetchImpl);
      expect(await EligibilityService.check(testEnv(), poll, 7, { selfKey: 7 })).toMatchObject({ reason: 'open' });
      expect(await EligibilityService.check(testEnv(), poll, 7)).toMatchObject({ reason: 'not_verified' });
      expect(await EligibilityService.check(testEnv(), poll, 8, { selfKey: 8 })).toMatchObject({ reason: 'not_verified' });
    });

    it('the plain answer route refuses a world_id wave', async () => {
      const { handleCreateAnswer } = await import('../../worker/handlers/answers');
      const poll = await worldWave();
      const res = await handleCreateAnswer(new Request('http://x/api/answers', {
        method: 'POST', body: JSON.stringify({ ...MC, q_id: Q, poll_id: poll.id, user_id: 7 }),
      }), testEnv());
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'not_eligible', reason: 'not_verified' });
      expect(await answers(poll.id)).toHaveLength(0);
    });
  });

  describe('verify', () => {
    it('sends the IDKit result unmodified and returns the decimal nullifier', async () => {
      const { fetchImpl, calls } = worldApi(N1);
      const result = idkitResult('w');
      const out = await verifyProof(CFG, 'w', result, fetchImpl);
      expect(out).toEqual({ ok: true, nullifier: BigInt(N1).toString(10), action: 'qbase-wave-w' });
      expect(calls).toEqual([{ url: `${WORLD_VERIFY_BASE}/rp_test`, body: result }]);
    });

    it('sends the staging verification token when one is configured', async () => {
      let headers: Headers | undefined;
      const fetchImpl = (async (_url: string, init?: RequestInit) => {
        headers = new Headers(init?.headers);
        return worldApi(N1).fetchImpl(_url, init);
      }) as typeof fetch;
      await verifyProof({ ...CFG, stagingToken: 'tok' }, 'w', idkitResult('w'), fetchImpl);
      expect(headers?.get('x-staging-verification-token')).toBe('tok');
      expect(headers?.get('user-agent')).toBeTruthy();
    });

    it('refuses a proof from another environment', async () => {
      const { fetchImpl } = worldApi(N1, { environment: 'production' });
      expect(await verifyProof(CFG, 'w', idkitResult('w'), fetchImpl)).toMatchObject({ ok: false, code: 'world_environment_mismatch' });
    });

    it('maps a World error to world_verify_failed', async () => {
      const { fetchImpl } = worldApi(N1, {}, 400);
      expect(await verifyProof(CFG, 'w', idkitResult('w'), fetchImpl))
        .toMatchObject({ ok: false, status: 400, code: 'world_verify_failed', detail: 'all_verifications_failed' });
    });

    it('checks action, protocol and credential before calling World', async () => {
      const { fetchImpl, calls } = worldApi(N1);
      expect(await verifyProof(CFG, 'w', idkitResult('other'), fetchImpl)).toMatchObject({ code: 'world_action_mismatch' });
      expect(await verifyProof(CFG, 'w', idkitResult('w', { protocol_version: '3.0' }), fetchImpl)).toMatchObject({ code: 'world_proof_invalid' });
      expect(await verifyProof(CFG, 'w', idkitResult('w', { responses: [{ identifier: 'passport' }] }), fetchImpl)).toMatchObject({ code: 'world_credential_mismatch' });
      expect(calls).toHaveLength(0);
    });

    it('a network failure is 502, not a crash', async () => {
      const failing = (async () => { throw new Error('down'); }) as unknown as typeof fetch;
      expect(await verifyProof(CFG, 'w', idkitResult('w'), failing)).toMatchObject({ ok: false, status: 502, code: 'world_unreachable' });
    });

    it('normalizes nullifiers to one decimal spelling', () => {
      expect(normalizeNullifier('0x0a')).toBe('10');
      expect(normalizeNullifier('10')).toBe('10');
      expect(normalizeNullifier('0x' + 'f'.repeat(65))).toBeNull();
      expect(normalizeNullifier('1e5')).toBeNull();
      expect(normalizeNullifier(5)).toBeNull();
    });
  });

  describe('answer', () => {
    it('success: verify → answer stored on the account → nullifier recorded without it', async () => {
      const poll = await worldWave();
      const { fetchImpl } = worldApi(N1);
      const res = await answerWithWorldProof(testEnv(), CFG, poll, 7, MC, idkitResult(poll.id), false, fetchImpl);
      expect(res.status).toBe(200);
      expect(await answers(poll.id)).toEqual([{ user_id: 7, value: 'Yes' }]);
      const rows = await nullifiers(poll.id);
      expect(rows).toHaveLength(1);
      expect(Object.keys(rows[0]).sort()).toEqual(['action', 'created_at', 'nullifier', 'poll_id']);
      expect(rows[0]).toMatchObject({ action: worldAction(poll.id), nullifier: BigInt(N1).toString(10) });
    });

    it('the same human again, on the same or a second account → 409, nothing written', async () => {
      const poll = await worldWave();
      const { fetchImpl } = worldApi(N1);
      await answerWithWorldProof(testEnv(), CFG, poll, 7, MC, idkitResult(poll.id), false, fetchImpl);
      const again = await answerWithWorldProof(testEnv(), CFG, poll, 8, { ...MC, value: 'No' }, idkitResult(poll.id), false, fetchImpl);
      expect(again.status).toBe(409);
      expect(await again.json()).toMatchObject({ code: 'world_id_used' });
      expect(await answers(poll.id)).toEqual([{ user_id: 7, value: 'Yes' }]);
      expect(await nullifiers(poll.id)).toHaveLength(1);
    });

    it('an account with no Farcaster fid (Ethereum / World login) answers with a proof; its other login is refused', async () => {
      // After the account cutover the person key is an opaque account id >= 2^40
      // and Users.fid holds it; this account has no farcaster credential.
      const ACCOUNT = 2 ** 40 + 7;
      await env.DB.batch([
        env.DB.prepare('INSERT INTO users (fid, fname) VALUES (?, ?)').bind(ACCOUNT, 'alice.eth'),
        env.DB.prepare("INSERT OR IGNORE INTO accounts (id, born_from, created_at) VALUES (?, 'ethereum', 0)").bind(ACCOUNT),
        env.DB.prepare("INSERT OR IGNORE INTO account_credentials (kind, value, account_id, label, created_at) VALUES ('ethereum', '0xa11ce', ?, 'alice.eth', 0)").bind(ACCOUNT),
      ]);
      const poll = await worldWave();
      const { fetchImpl } = worldApi(N1);
      const res = await answerWithWorldProof(testEnv(), CFG, poll, ACCOUNT, MC, idkitResult(poll.id), false, fetchImpl);
      expect(res.status).toBe(200);
      expect(await answers(poll.id)).toEqual([{ user_id: ACCOUNT, value: 'Yes' }]);
      // Snapshot gates need a fid; the world_id gate looks the account up by person key.
      expect(await EligibilityService.check(testEnv(), poll, undefined, { selfKey: ACCOUNT })).toMatchObject({ eligible: true, reason: 'open' });
      // Same human through a different account (their Farcaster one): refused.
      const again = await answerWithWorldProof(testEnv(), CFG, poll, 7, { ...MC, value: 'No' }, idkitResult(poll.id), false, fetchImpl);
      expect(again.status).toBe(409);
      expect(await answers(poll.id)).toHaveLength(1);
    });

    it('two distinct 78-digit nullifiers are two humans', async () => {
      const poll = await worldWave();
      expect(BigInt(N1).toString(10)).toHaveLength(78);
      expect(Number(BigInt(N1))).toBe(Number(BigInt(N2))); // why the column is TEXT
      expect((await answerWithWorldProof(testEnv(), CFG, poll, 7, MC, idkitResult(poll.id), false, worldApi(N1).fetchImpl)).status).toBe(200);
      expect((await answerWithWorldProof(testEnv(), CFG, poll, 8, MC, idkitResult(poll.id), false, worldApi(N2).fetchImpl)).status).toBe(200);
      expect(await nullifiers(poll.id)).toHaveLength(2);
      expect(await answers(poll.id)).toHaveLength(2);
    });

    it('one human answers two waves: unrelated nullifier rows, both accepted', async () => {
      const a = await worldWave();
      const b = await worldWave();
      const { fetchImpl } = worldApi(N1);
      expect((await answerWithWorldProof(testEnv(), CFG, a, 7, MC, idkitResult(a.id), false, fetchImpl)).status).toBe(200);
      expect((await answerWithWorldProof(testEnv(), CFG, b, 7, MC, idkitResult(b.id), false, fetchImpl)).status).toBe(200);
    });

    it('a failed answer write releases the nullifier (the attempt is not used up)', async () => {
      const poll = await worldWave();
      const { fetchImpl } = worldApi(N1);
      await env.DB.prepare("CREATE TRIGGER fail_answer BEFORE INSERT ON Answers BEGIN SELECT RAISE(ABORT, 'boom'); END").run();
      try {
        const res = await answerWithWorldProof(testEnv(), CFG, poll, 7, MC, idkitResult(poll.id), false, fetchImpl);
        expect(res.status).toBe(500);
      } finally {
        await env.DB.prepare('DROP TRIGGER fail_answer').run();
      }
      expect(await nullifiers(poll.id)).toHaveLength(0);
      expect(await answers(poll.id)).toHaveLength(0);
      // …and the same human can then answer.
      expect((await answerWithWorldProof(testEnv(), CFG, poll, 7, MC, idkitResult(poll.id), false, fetchImpl)).status).toBe(200);
    });

    it('a refused answer (bad input) releases the nullifier too', async () => {
      const poll = await worldWave();
      const res = await answerWithWorldProof(testEnv(), CFG, poll, 7, { ...MC, audience: 'Nope' }, idkitResult(poll.id), false, worldApi(N1).fetchImpl);
      expect(res.status).toBe(400);
      expect(await nullifiers(poll.id)).toHaveLength(0);
    });

    it('a rejected proof writes nothing', async () => {
      const poll = await worldWave();
      const res = await answerWithWorldProof(testEnv(), CFG, poll, 7, MC, idkitResult(poll.id), false, worldApi(N1, {}, 400).fetchImpl);
      expect(res.status).toBe(400);
      expect(await answers(poll.id)).toHaveLength(0);
      expect(await nullifiers(poll.id)).toHaveLength(0);
    });

    it('an account that already answered changes its answer without a new proof', async () => {
      const poll = await worldWave();
      const { fetchImpl, calls } = worldApi(N1);
      await answerWithWorldProof(testEnv(), CFG, poll, 7, MC, idkitResult(poll.id), false, fetchImpl);
      const res = await answerWithWorldProof(testEnv(), CFG, poll, 7, { ...MC, value: 'No' }, undefined, true, fetchImpl);
      expect(res.status).toBe(200);
      expect(calls).toHaveLength(1);
      expect((await answers(poll.id)).map(a => a.value)).toEqual(['Yes', 'No']);
      expect(await nullifiers(poll.id)).toHaveLength(1);
    });
  });
});
