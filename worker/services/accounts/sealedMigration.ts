/**
 * Sealed data bound to the pre-rewrite key (docs/specs/account-root.md §5).
 *
 *  - reowner: Secret envelopes on Answers (QStorage objects) and
 *    quiz_completions (D1 column) carry AAD `<key>|<tier>|<owner>`, owner =
 *    the row's person key. After the rewrite the row names an account id, so
 *    the envelope is opened under the legacy owner and re-sealed under the
 *    account id. `reverse` does the opposite (rollback).
 *  - retag: anon_attributions carry HMAC("<key>|<scope>") and the key sealed
 *    in author_ct. Both are recomputed over the account id. `reverse` puts the
 *    legacy key back.
 *
 * Batched, cursor-driven and idempotent: a row already in the target shape is
 * counted and skipped. Runs inside the Worker; keys never leave it.
 */

import { SecretBox, isEnvelope, type Envelope } from '../secret/SecretBox';
import { SecretStore, ctxFor } from '../secret/SecretStore';
import { storageKeyOf } from '../../handlers/answers/shared';
import { completionCtx } from '../../routes/quiz-completions';
import { anonTag, attributionCtx } from '../anon/AnonTag';
import { ACCOUNT_ID_MIN } from './migrationSql';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

export interface SweepReport {
  phase: 'reowner' | 'retag';
  target?: string;
  dryRun: boolean;
  reverse: boolean;
  processed: number;
  changed: number;
  already: number;
  skipped: number;
  errors: Array<{ id: string; error: string }>;
  nextCursor: string | null;
  done: boolean;
}

const report = (phase: SweepReport['phase'], o: { dryRun: boolean; reverse: boolean }, target?: string): SweepReport =>
  ({ phase, target, dryRun: o.dryRun, reverse: o.reverse, processed: 0, changed: 0, already: 0, skipped: 0, errors: [], nextCursor: null, done: false });

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface SweepOpts { dryRun: boolean; limit: number; cursor?: string; reverse: boolean }

// ── reowner ──────────────────────────────────────────────────────────────────

export async function reownerPhase(env: Env, o: SweepOpts & { target: 'answers' | 'completions' }): Promise<SweepReport> {
  return o.target === 'completions' ? reownerCompletions(env, o) : reownerAnswers(env, o);
}

async function reownerAnswers(env: Env, o: SweepOpts): Promise<SweepReport> {
  const r = report('reowner', o, 'answers');
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.q_id, a.audience, a.storage_ref, a.user_id, acc.legacy_key
     FROM Answers a JOIN accounts acc ON acc.id = a.user_id
     WHERE a.storage_ref IS NOT NULL AND a.storage_ref <> '' AND acc.legacy_key IS NOT NULL AND a.id > ?
     ORDER BY a.id LIMIT ?`,
  ).bind(o.cursor ?? '', o.limit).all();
  const rows = (results ?? []) as Array<{ id: string; q_id: string; audience: string; storage_ref: string; user_id: number; legacy_key: number }>;
  for (const row of rows) {
    r.processed++;
    try {
      const key = storageKeyOf(row.storage_ref);
      if (!key) { r.skipped++; continue; }
      const stored = await SecretStore.peek(env, key);
      if (!stored?.envelope) { r.skipped++; continue; } // missing or plaintext: not this sweep's job
      const [from, to] = o.reverse ? [row.user_id, row.legacy_key] : [row.legacy_key, row.user_id];
      const fromCtx = ctxFor(key, row.audience, from);
      const toCtx = ctxFor(key, row.audience, to);
      if (stored.envelope.ctx === toCtx) { r.already++; continue; }
      if (stored.envelope.ctx !== fromCtx) { r.errors.push({ id: row.id, error: `unexpected ctx ${stored.envelope.ctx}` }); continue; }
      if (!o.dryRun) {
        const obj = await SecretStore.getJSON(env, key, { tier: row.audience, owner: from });
        await SecretStore.putJSON(env, key, obj, {
          tier: row.audience, owner: to,
          meta: { 'q-id': row.q_id, 'user-id': String(to), audience: row.audience },
        });
      }
      r.changed++;
    } catch (e) {
      r.errors.push({ id: row.id, error: errText(e) });
    }
  }
  r.nextCursor = rows.length === o.limit ? rows[rows.length - 1].id : null;
  r.done = r.nextCursor === null;
  return r;
}

async function reownerCompletions(env: Env, o: SweepOpts): Promise<SweepReport> {
  const r = report('reowner', o, 'completions');
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.visibility, c.user_id, c.answers_encrypted, acc.legacy_key
     FROM quiz_completions c JOIN accounts acc ON acc.id = c.user_id
     WHERE c.answers_encrypted IS NOT NULL AND c.answers_encrypted <> '' AND acc.legacy_key IS NOT NULL AND c.id > ?
     ORDER BY c.id LIMIT ?`,
  ).bind(o.cursor ?? '', o.limit).all();
  const rows = (results ?? []) as Array<{ id: string; visibility: string; user_id: number; answers_encrypted: string; legacy_key: number }>;
  for (const row of rows) {
    r.processed++;
    try {
      let env0: Envelope | null = null;
      try {
        const parsed = JSON.parse(row.answers_encrypted);
        env0 = isEnvelope(parsed) ? parsed : null;
      } catch { env0 = null; }
      if (!env0) { r.skipped++; continue; }
      const [from, to] = o.reverse ? [row.user_id, row.legacy_key] : [row.legacy_key, row.user_id];
      const fromCtx = completionCtx(row.id, row.visibility, from);
      const toCtx = completionCtx(row.id, row.visibility, to);
      if (env0.ctx === toCtx) { r.already++; continue; }
      if (env0.ctx !== fromCtx) { r.errors.push({ id: row.id, error: `unexpected ctx ${env0.ctx}` }); continue; }
      if (!o.dryRun) {
        const obj = await SecretStore.openFromD1(env, row.answers_encrypted, fromCtx);
        const sealed = await SecretStore.sealForD1(env, JSON.stringify(obj), toCtx);
        const res = await env.DB.prepare('UPDATE quiz_completions SET answers_encrypted = ? WHERE id = ? AND answers_encrypted = ?')
          .bind(sealed, row.id, row.answers_encrypted).run();
        if (!res.meta?.changes) { r.errors.push({ id: row.id, error: 'row changed underneath; re-run' }); continue; }
      }
      r.changed++;
    } catch (e) {
      r.errors.push({ id: row.id, error: errText(e) });
    }
  }
  r.nextCursor = rows.length === o.limit ? rows[rows.length - 1].id : null;
  r.done = r.nextCursor === null;
  return r;
}

// ── retag ────────────────────────────────────────────────────────────────────

export async function retagPhase(env: Env, o: SweepOpts): Promise<SweepReport> {
  const r = report('retag', o);
  const { results } = await env.DB.prepare(
    `SELECT t.id, t.public_id, t.author_id, t.author_tag, t.author_ct, t.type, a.q_id AS answer_q_id
     FROM anon_attributions t LEFT JOIN Answers a ON a.id = t.public_id AND t.type = 'answer'
     WHERE t.id > ? ORDER BY t.id LIMIT ?`,
  ).bind(o.cursor ?? '', o.limit).all();
  const rows = (results ?? []) as Array<{ id: string; public_id: string; author_id: number | null; author_tag: string | null; author_ct: string | null; type: string; answer_q_id: string | null }>;
  for (const row of rows) {
    r.processed++;
    try {
      const scope = row.type === 'answer' ? row.answer_q_id : row.public_id;
      if (!scope) { r.skipped++; continue; }
      const sealedKey = row.author_ct
        ? Number(await SecretBox.openText(env, row.author_ct, attributionCtx(row.public_id)))
        : row.author_id;
      if (sealedKey === null || !Number.isFinite(sealedKey)) { r.skipped++; continue; }
      const isAccount = sealedKey >= ACCOUNT_ID_MIN;
      let target: number | null;
      if (!o.reverse) {
        if (isAccount) { r.already++; continue; }
        const acc = await env.DB.prepare(
          `SELECT id FROM accounts WHERE legacy_key = ?
           UNION ALL SELECT account_id AS id FROM account_credentials WHERE kind = 'farcaster' AND value = ? LIMIT 1`,
        ).bind(sealedKey, String(sealedKey)).first() as { id: number } | null;
        target = acc ? Number(acc.id) : null;
      } else {
        if (!isAccount) { r.already++; continue; }
        const acc = await env.DB.prepare('SELECT legacy_key FROM accounts WHERE id = ?').bind(sealedKey).first() as { legacy_key: number | null } | null;
        target = acc?.legacy_key != null ? Number(acc.legacy_key) : null;
      }
      if (target === null) { r.errors.push({ id: row.id, error: `no ${o.reverse ? 'legacy key' : 'account'} for the sealed author` }); continue; }
      if (!o.dryRun) {
        const tag = await anonTag(env, target, scope);
        const ct = await SecretBox.sealText(env, String(target), attributionCtx(row.public_id));
        await env.DB.prepare('UPDATE anon_attributions SET author_id = NULL, author_tag = ?, author_ct = ? WHERE id = ?').bind(tag, ct, row.id).run();
      }
      r.changed++;
    } catch (e) {
      r.errors.push({ id: row.id, error: errText(e) });
    }
  }
  r.nextCursor = rows.length === o.limit ? rows[rows.length - 1].id : null;
  r.done = r.nextCursor === null;
  return r;
}
