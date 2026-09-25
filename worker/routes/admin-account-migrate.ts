/**
 * admin-account-migrate — cut qbase over from fids to account ids
 * (docs/specs/account-root.md §6, option 2).
 *
 * POST /api/admin/account-migrate
 *   { phase: 'status' | 'accounts' | 'rewrite' | 'unrewrite' | 'attach' | 'reowner' | 'retag',
 *     dryRun?: boolean, limit?: number, cursor?: string, target?: 'answers' | 'completions',
 *     reverse?: boolean, accountId?: number, fid?: number }
 *
 *   status     counts: accounts, credentials, legacy values left per column, ambiguous accounts
 *   accounts   an account for every unmapped person key, farcaster + passkey credentials,
 *              state → 'accounts'. Refuses while the preflight checks are non-zero.
 *   rewrite    re-runs `accounts`, then ONE batch: every person-key column fid → account id,
 *              the log of non-invertible remaps, state → 'rewritten'. Run again a minute
 *              later to sweep rows an old-mode isolate wrote meanwhile (expect 0).
 *   unrewrite  the exact inverse, one batch, state → 'accounts'.
 *   attach     settle an ambiguous legacy account: attach farcaster credential `fid` to it.
 *   reowner    re-seal Secret envelopes whose ctx still names a legacy key (batched, cursor).
 *   retag      re-tag / re-seal anon attributions over account ids (batched, cursor).
 *
 * Every phase is idempotent: account ids are >= 2^40 and legacy keys < 2^40, so
 * each statement only selects what is not yet done.
 *
 * Auth: X-Admin-Secret must match env.QBASE_ADMIN_SECRET. Runs inside the
 * Worker because reowner / retag need ANSWER_KEKS and ANON_TAG_KEY.
 */

import {
  accountsStatements, rewriteStatements, unrewriteStatements, statusQueries, preflightChecks,
  UNLINKED_PASSKEYS_SQL, AMBIGUOUS_ACCOUNTS_SQL, type Has,
} from '../services/accounts/migrationSql';
import {
  _resetAccountCaches, migrationState, randomAccountId, credentialValue, AccountError,
} from '../services/accounts/AccountService';
import { anonPlaceholderFid } from '../services/anon/AnonTag';
import { reownerPhase, retagPhase } from '../services/accounts/sealedMigration';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

type Phase = 'status' | 'accounts' | 'rewrite' | 'unrewrite' | 'attach' | 'reowner' | 'retag';

interface Body {
  phase?: Phase;
  dryRun?: boolean;
  limit?: number;
  cursor?: string;
  target?: 'answers' | 'completions';
  reverse?: boolean;
  accountId?: number;
  fid?: number;
}

async function tableSet(env: Env): Promise<Has> {
  const r = await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all();
  const names = new Set(((r.results ?? []) as Array<{ name: string }>).map(x => x.name.toLowerCase()));
  return (t: string) => names.has(t.toLowerCase());
}

async function counts(env: Env, qs: Array<{ name: string; sql: string }>): Promise<Record<string, number>> {
  if (!qs.length) return {};
  const res = await env.DB.batch(qs.map(q => env.DB.prepare(q.sql)));
  return Object.fromEntries(qs.map((q, i) => [q.name, Number((res[i].results?.[0] as { n: number } | undefined)?.n ?? 0)]));
}

export async function status(env: Env) {
  const has = await tableSet(env);
  if (!has('accounts')) return { state: 'none', note: 'migration 0076 not applied' };
  _resetAccountCaches();
  const state = await migrationState(env);
  const c = await counts(env, statusQueries(has, anonPlaceholderFid(env)));
  const pre = await counts(env, preflightChecks(has));
  const ambiguous = ((await env.DB.prepare(AMBIGUOUS_ACCOUNTS_SQL).all()).results ?? []) as Array<{ id: number; legacy_key: number }>;
  const legacyLeft = Object.entries(c).filter(([k, v]) => k.endsWith('_legacy_values') && v > 0);
  return { state, counts: c, preflight: pre, ambiguous_accounts: ambiguous, legacy_values_left: Object.fromEntries(legacyLeft) };
}

async function runSequential(env: Env, statements: string[]): Promise<void> {
  for (const s of statements) await env.DB.prepare(s).run();
}

/** Mint accounts for passkeys that have no credential after the set-based statements. */
async function mintUnlinkedPasskeys(env: Env, now: number): Promise<number> {
  const rows = ((await env.DB.prepare(UNLINKED_PASSKEYS_SQL).all()).results ?? []) as Array<{ address: string; display_name: string | null }>;
  let minted = 0;
  for (const p of rows) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const id = randomAccountId();
      try {
        await env.DB.batch([
          env.DB.prepare(`INSERT INTO accounts (id, born_from, legacy_key, created_at) VALUES (?, 'passkey', NULL, ?)`).bind(id, now),
          env.DB.prepare(`INSERT INTO account_credentials (kind, value, account_id, label, created_at) VALUES ('passkey', ?, ?, ?, ?)`)
            .bind(credentialValue('passkey', p.address), id, p.display_name, now),
          env.DB.prepare(`INSERT OR IGNORE INTO Users (fid, fname, display_name, profile_source, quil_address) VALUES (?, ?, ?, 'passkey', ?)`)
            .bind(id, p.display_name ?? `passkey-${String(id).slice(-6)}`, p.display_name, p.address),
        ]);
        minted += 1;
        break;
      } catch {
        const done = await env.DB.prepare(`SELECT 1 AS x FROM account_credentials WHERE kind = 'passkey' AND value = ?`).bind(p.address).first();
        if (done) break;
      }
    }
  }
  return minted;
}

async function accountsPhase(env: Env, has: Has, dryRun: boolean) {
  const pre = await counts(env, preflightChecks(has));
  const blocking = Object.entries(pre).filter(([, v]) => v > 0);
  if (blocking.length) return { phase: 'accounts', refused: true, preflight: pre };
  const before = await counts(env, statusQueries(has, anonPlaceholderFid(env)));
  if (dryRun) return { phase: 'accounts', dryRun, would_map_keys: Object.fromEntries(Object.entries(before).filter(([k]) => k.endsWith('_unmapped_keys'))) };
  const now = Date.now();
  await runSequential(env, accountsStatements(has, now));
  const minted = await mintUnlinkedPasskeys(env, now);
  _resetAccountCaches();
  const after = await counts(env, statusQueries(has, anonPlaceholderFid(env)));
  return { phase: 'accounts', dryRun, minted_passkey_accounts: minted, before, after };
}

async function rewritePhase(env: Env, has: Has, dryRun: boolean) {
  const state = await migrationState(env);
  if (state === 'none') return { phase: 'rewrite', refused: true, reason: 'run the accounts phase first' };
  const pre = await accountsPhase(env, has, dryRun);
  if ('refused' in pre && pre.refused) return { phase: 'rewrite', refused: true, preflight: pre };
  const before = await counts(env, statusQueries(has, anonPlaceholderFid(env)));
  if (dryRun) return { phase: 'rewrite', dryRun, legacy_values: Object.fromEntries(Object.entries(before).filter(([k]) => k.endsWith('_legacy_values'))) };
  const anonFid = anonPlaceholderFid(env);
  await env.DB.batch(rewriteStatements(has, anonFid, Date.now()).map(s => env.DB.prepare(s)));
  _resetAccountCaches();
  const after = await counts(env, statusQueries(has, anonPlaceholderFid(env)));
  return { phase: 'rewrite', dryRun, before, after };
}

async function unrewritePhase(env: Env, has: Has, dryRun: boolean) {
  if (dryRun) return { phase: 'unrewrite', dryRun, state: await migrationState(env) };
  await env.DB.batch(unrewriteStatements(has).map(s => env.DB.prepare(s)));
  _resetAccountCaches();
  return { phase: 'unrewrite', dryRun, after: await counts(env, statusQueries(has, anonPlaceholderFid(env))) };
}

async function attachPhase(env: Env, body: Body) {
  const accountId = Number(body.accountId);
  const acct = await env.DB.prepare(`SELECT id, born_from FROM accounts WHERE id = ?`).bind(accountId).first() as { id: number; born_from: string } | null;
  if (!acct) throw new AccountError('no_such_account', 404);
  if (acct.born_from !== 'legacy') throw new AccountError('not_a_legacy_account');
  const value = credentialValue('farcaster', Number(body.fid));
  const taken = await env.DB.prepare(`SELECT account_id FROM account_credentials WHERE kind = 'farcaster' AND value = ?`).bind(value).first();
  if (taken) throw new AccountError('credential_in_use');
  if (body.dryRun) return { phase: 'attach', dryRun: true, accountId, fid: Number(value) };
  await env.DB.prepare(`INSERT INTO account_credentials (kind, value, account_id, created_at) VALUES ('farcaster', ?, ?, ?)`).bind(value, accountId, Date.now()).run();
  _resetAccountCaches();
  return { phase: 'attach', dryRun: false, accountId, fid: Number(value) };
}

export async function handleAdminAccountMigrate(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/api/admin/account-migrate' || request.method !== 'POST') return null;
  if (!env.QBASE_ADMIN_SECRET || request.headers.get('X-Admin-Secret') !== env.QBASE_ADMIN_SECRET) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }
  let body: Body = {};
  try {
    body = (await request.json()) as Body;
  } catch {
    body = {};
  }
  const phase: Phase = body.phase ?? 'status';
  const dryRun = body.dryRun === true;
  try {
    const has = await tableSet(env);
    if (phase === 'status') return Response.json(await status(env));
    if (!has('accounts')) return Response.json({ error: 'migration 0076 not applied' }, { status: 409 });
    if (phase === 'accounts') return Response.json(await accountsPhase(env, has, dryRun));
    if (phase === 'rewrite') return Response.json(await rewritePhase(env, has, dryRun));
    if (phase === 'unrewrite') return Response.json(await unrewritePhase(env, has, dryRun));
    if (phase === 'attach') return Response.json(await attachPhase(env, body));
    if (phase === 'reowner' || phase === 'retag') {
      if (!(await migrationState(env) === 'rewritten') && !body.reverse) {
        return Response.json({ error: 'run the rewrite phase first' }, { status: 409 });
      }
      const limit = Math.min(100, Math.max(1, Number(body.limit) || 25));
      if (phase === 'reowner') return Response.json(await reownerPhase(env, { target: body.target ?? 'answers', dryRun, limit, cursor: body.cursor, reverse: body.reverse === true }));
      return Response.json(await retagPhase(env, { dryRun, limit, cursor: body.cursor, reverse: body.reverse === true }));
    }
    return Response.json({ error: `unknown phase ${phase}` }, { status: 400 });
  } catch (e) {
    if (e instanceof AccountError) return Response.json({ error: e.code }, { status: e.status });
    console.error('[account-migrate] failed:', e);
    return Response.json({ error: String((e as Error).message ?? e) }, { status: 500 });
  }
}
