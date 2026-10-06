/**
 * archive:commit(pollId): a closed wave's result, committed (plan 2026-09-25
 * §7.4, §8.6–§8.7). Behind `ENS_WRITES_ENABLED = "1"` (staging only).
 *
 *   1. build the bundle once and keep its bytes (wave_commitments, 0075)
 *   2. post it to Arweave, signed by the archive key; if that fails the
 *      bundle is served by qbase at /api/archive/waves/:id/bundle and the
 *      chain still holds its hash (the §7.4 fallback)
 *   3. one multicall of the §7.3 records on <qid>.q.askqbase.eth from the
 *      writer. The name normally exists already (the sweep names a question
 *      when its wave opens); if not, the namer key registers it here. With no
 *      namer configured the wave waits as `awaiting_name`.
 *   4. committed when the receipt succeeds
 *
 * Idempotent on poll_id and safe to re-run at any step: a lease keeps two
 * runs from sending two transactions, a sent transaction is recorded before
 * its receipt is awaited, and a reverted one is re-sent.
 *
 * Runs from the `*\/10` cron (waves closing after `ARCHIVE_SINCE`, so nothing
 * archived before the audience chooser says so gets swept) and from
 * POST /api/admin/archive/waves/:id/commit.
 */

import { getPoll, isPollClosed, type PollRow } from '../PollService';
import { buildWaveBundle, questionEnsName, type BundleEnv, type WaveBundle } from './WaveBundle';
import { canonicalJson, sha256Hex } from './canonicalJson';
import { arweaveContenthash, postBundle, ArweaveUnavailable, type ArchiveEnv, type Tag } from './ArweaveService';
import { sepoliaEns, type EnsEnv, type EnsPort, type ReceiptState } from './EnsService';

export type CommitStatus = 'building' | 'posted' | 'awaiting_name' | 'submitted' | 'committed';

export interface CommitmentRow {
  poll_id: string;
  question_id: string;
  ens_name: string;
  status: CommitStatus;
  bundle_json: string;
  bundle_sha256: string;
  committed_tally: string;
  ar_tx: string | null;
  ar_error: string | null;
  chain_id: number | null;
  tx_hash: string | null;
  error: string | null;
  attempts: number;
  lease_until: string | null;
  created_at: string;
  updated_at: string;
  committed_at: string | null;
}

export type CommitEnv = BundleEnv & ArchiveEnv & EnsEnv & {
  ENS_WRITES_ENABLED?: string;
  ARCHIVE_SINCE?: string;
};

export interface CommitDeps {
  ens?: EnsPort;
  fetch?: typeof fetch;
  now?: () => Date;
  /** How long to wait for a receipt inside this run before leaving it to the next one. */
  receiptWaitMs?: number;
}

export type CommitOutcome =
  | { status: 'disabled' | 'not_found' | 'not_closed' | 'busy' }
  | { status: CommitStatus; row: CommitmentRow };

const LEASE_MS = 5 * 60_000;

export function writesEnabled(env: { ENS_WRITES_ENABLED?: string }): boolean {
  return env.ENS_WRITES_ENABLED === '1';
}

export async function getCommitment(env: BundleEnv, pollId: string): Promise<CommitmentRow | null> {
  return (await env.DB.prepare('SELECT * FROM wave_commitments WHERE poll_id = ?').bind(pollId).first()) as CommitmentRow | null;
}

/** Where a reader gets the bundle: Arweave when it is there, else qbase. */
export function bundleUrl(env: BundleEnv, row: Pick<CommitmentRow, 'poll_id' | 'ar_tx'>): string {
  return row.ar_tx ? `ar://${row.ar_tx}` : `https://${env.HOSTNAME || 'qbase.tech'}/api/archive/waves/${row.poll_id}/bundle`;
}

/** The `qbase.wave.<id>` record: the plan §7.3 keys, canonical JSON. */
export function waveSummary(bundle: WaveBundle, tallySha256: string, bundleRef: string): string {
  return canonicalJson({
    closed_at: bundle.wave.closed_at,
    n: bundle.n,
    n_verified: bundle.n_verified,
    gate: bundle.wave.gate,
    published_by: bundle.wave.published_by,
    tally_sha256: tallySha256,
    bundle: bundleRef,
  });
}

function arweaveTags(bundle: WaveBundle, sha256: string): Tag[] {
  return [
    { name: 'Content-Type', value: 'application/json' },
    { name: 'App-Name', value: 'qbase' },
    { name: 'Schema', value: bundle.schema },
    { name: 'Question-Id', value: bundle.question.id },
    { name: 'Wave-Id', value: bundle.wave.id },
    { name: 'Bundle-SHA256', value: sha256 },
  ];
}

async function update(env: BundleEnv, pollId: string, fields: Partial<CommitmentRow>, now: Date): Promise<void> {
  const entries = Object.entries({ ...fields, updated_at: now.toISOString() });
  await env.DB.prepare(`UPDATE wave_commitments SET ${entries.map(([k]) => `${k} = ?`).join(', ')} WHERE poll_id = ?`)
    .bind(...entries.map(([, v]) => v ?? null), pollId).run();
}

async function ensureRow(env: BundleEnv, poll: PollRow, now: Date): Promise<CommitmentRow | null> {
  const existing = await getCommitment(env, poll.id);
  if (existing) return existing;
  const built = await buildWaveBundle(env, poll);
  if (!built) return null;
  const at = now.toISOString();
  await env.DB.prepare(`
    INSERT OR IGNORE INTO wave_commitments
      (poll_id, question_id, ens_name, status, bundle_json, bundle_sha256, committed_tally, attempts, created_at, updated_at)
    VALUES (?, ?, ?, 'building', ?, ?, ?, 0, ?, ?)
  `).bind(poll.id, poll.question_id, built.bundle.question.ens_name, built.json, built.sha256, canonicalJson(built.bundle.tally), at, at).run();
  return getCommitment(env, poll.id);
}

/** Record a successful commit on one chain (0077); a replay to another chain adds a row, never replaces one. */
async function recordChainCommit(env: BundleEnv, row: CommitmentRow, chainId: number, txHash: string, at: string): Promise<void> {
  try {
    await env.DB.prepare(`
      INSERT OR IGNORE INTO wave_chain_commits (poll_id, chain_id, ens_name, tx_hash, committed_at)
      VALUES (?, ?, ?, ?, ?)
    `).bind(row.poll_id, chainId, row.ens_name, txHash, at).run();
  } catch (e) {
    // 0077 not applied yet: wave_commitments still holds the commit
    console.warn('[archive] wave_chain_commits unavailable:', e instanceof Error ? e.message : e);
  }
}

export interface ChainCommit { chain_id: number; ens_name: string; tx_hash: string; committed_at: string; note: string | null }

export async function listChainCommits(env: BundleEnv, pollId: string): Promise<ChainCommit[]> {
  try {
    const { results } = await env.DB.prepare(
      'SELECT chain_id, ens_name, tx_hash, committed_at, note FROM wave_chain_commits WHERE poll_id = ? ORDER BY committed_at',
    ).bind(pollId).all();
    return (results || []) as ChainCommit[];
  } catch {
    return [];
  }
}

/**
 * The `qbase.waves` index this commit writes: every wave of the question whose
 * records are on chain or on their way (a `submitted` wave has a transaction
 * out; if it reverts it is re-sent and lands later, so leaving it out would
 * drop it from the index until some later wave on the question commits).
 * Ordered by the commitment's creation so the list is stable across runs.
 */
async function indexedWaveIds(env: BundleEnv, questionId: string, pollId: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT poll_id FROM wave_commitments WHERE question_id = ? AND status IN ('committed', 'submitted') AND poll_id != ? ORDER BY created_at, poll_id`,
  ).bind(questionId, pollId).all();
  return [...((results || []) as Array<{ poll_id: string }>).map((r) => r.poll_id), pollId];
}

async function waitForReceipt(ens: EnsPort, tx: `0x${string}`, waitMs: number): Promise<ReceiptState> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const state = await ens.receipt(tx);
    if (state !== 'pending' || Date.now() >= deadline) return state;
    await new Promise((r) => setTimeout(r, 3000));
  }
}

/**
 * A transaction a previous run sent that the chain no longer knows (no receipt,
 * not in the mempool) was evicted and will never land; waiting on it would
 * leave the wave `submitted` forever. Asked twice, a few seconds apart, so a
 * freshly broadcast transaction that one RPC node has not seen yet is not
 * mistaken for a dropped one.
 */
async function confirmDropped(ens: EnsPort, tx: `0x${string}`, recheckMs: number): Promise<boolean> {
  await new Promise((r) => setTimeout(r, recheckMs));
  return (await ens.receipt(tx)) === 'dropped';
}

export type NameState = 'named' | 'unnamed' | 'pending';

/**
 * Make sure `<qid>.q.askqbase.eth` exists and carries qbase.question +
 * qbase.canonical. Registers from the namer key when it is missing. A
 * registration that reverts because someone else just registered the label is
 * fine: the name is re-read afterwards.
 */
export async function ensureNamed(env: CommitEnv, ens: EnsPort, questionId: string, deps: CommitDeps = {}): Promise<NameState> {
  const name = questionEnsName(env, questionId);
  const waitMs = deps.receiptWaitMs ?? 45_000;
  if (!(await ens.isNamed(name))) {
    if (!ens.canName()) return 'unnamed';
    const tx = await ens.register(name.split('.')[0]);
    console.log(`[archive] naming ${name}: ${tx}`);
    const state = await waitForReceipt(ens, tx, waitMs);
    if (state === 'pending') return 'pending';
    if (!(await ens.isNamed(name))) return 'unnamed';
  }
  if ((await ens.readText(name, 'qbase.question')) === null) {
    const q = await env.DB.prepare('SELECT id, stem FROM queries WHERE id = ?').bind(questionId).first() as { id: string; stem: string } | null;
    if (!q) return 'named';
    const tx = await ens.writeQuestionRecords(name, q);
    console.log(`[archive] question records on ${name}: ${tx}`);
    await waitForReceipt(ens, tx, waitMs);
  }
  return 'named';
}

export async function commitWave(env: CommitEnv, pollId: string, deps: CommitDeps = {}): Promise<CommitOutcome> {
  if (!writesEnabled(env)) return { status: 'disabled' };
  const now = deps.now ?? (() => new Date());
  const poll = await getPoll(env.DB, pollId);
  if (!poll) return { status: 'not_found' };
  if (!isPollClosed(poll, now().getTime())) return { status: 'not_closed' };

  let row = await ensureRow(env, poll, now());
  if (!row) return { status: 'not_found' };
  if (row.status === 'committed') return { status: 'committed', row };

  // Take the lease: one run per wave at a time.
  const t = now();
  const claimed = await env.DB.prepare(`
    UPDATE wave_commitments SET lease_until = ?, attempts = attempts + 1, updated_at = ?
    WHERE poll_id = ? AND status != 'committed' AND (lease_until IS NULL OR lease_until < ?)
  `).bind(new Date(t.getTime() + LEASE_MS).toISOString(), t.toISOString(), pollId, t.toISOString()).run();
  if (!claimed.meta?.changes) return { status: 'busy' };

  const ens = deps.ens ?? sepoliaEns(env);
  try {
    const bundle = JSON.parse(row.bundle_json) as WaveBundle;

    // 2. Arweave, once. A failure is recorded and the bundle falls back to qbase.
    if (!row.ar_tx && !row.ar_error) {
      try {
        const id = await postBundle(env, row.bundle_json, arweaveTags(bundle, row.bundle_sha256), deps.fetch);
        await update(env, pollId, { ar_tx: id, status: 'posted' }, now());
      } catch (e) {
        const msg = e instanceof ArweaveUnavailable ? e.message : `upload failed: ${e instanceof Error ? e.message : String(e)}`;
        console.warn(`[archive] ${pollId}: Arweave skipped (${msg}); bundle served by qbase`);
        await update(env, pollId, { ar_error: msg.slice(0, 500), status: 'posted' }, now());
      }
      row = (await getCommitment(env, pollId))!;
    }

    // 3a. A transaction already sent: settle it before sending another.
    if (row.tx_hash) {
      const sent = row.tx_hash as `0x${string}`;
      const waitMs = deps.receiptWaitMs ?? 45_000;
      let state = await waitForReceipt(ens, sent, waitMs);
      if (state === 'dropped' && !(await confirmDropped(ens, sent, Math.min(5_000, waitMs)))) state = 'pending';
      if (state === 'success') {
        const at = now().toISOString();
        await update(env, pollId, { status: 'committed', committed_at: at, error: null }, now());
        await recordChainCommit(env, row, row.chain_id ?? ens.chainId, row.tx_hash, at);
        return { status: 'committed', row: (await getCommitment(env, pollId))! };
      }
      if (state === 'pending') return { status: 'submitted', row };
      await update(env, pollId, { tx_hash: null, error: `transaction ${sent} ${state}; re-sending` }, now());
    }

    // 3b. The name must exist; the namer creates it if the sweep has not already.
    const name = row.ens_name || questionEnsName(env, poll.question_id);
    const named = await ensureNamed(env, ens, poll.question_id, deps);
    if (named !== 'named') {
      const why = named === 'pending'
        ? `${name}: registration sent, not yet mined; the next run continues`
        : `${name} is not registered and no namer key is set; run scripts/ens/grant-namer.ts or setup.ts --question ${poll.question_id}`;
      await update(env, pollId, { status: 'awaiting_name', error: why }, now());
      return { status: 'awaiting_name', row: (await getCommitment(env, pollId))! };
    }

    // 3c. One multicall of the records.
    const tallyHex = await sha256Hex(row.committed_tally); // committed_tally is the tally's canonical JSON
    const tx = await ens.commit(name, {
      waves: await indexedWaveIds(env, poll.question_id, pollId),
      pollId,
      summary: waveSummary(bundle, tallyHex, bundleUrl(env, row)),
      bundleSha256: row.bundle_sha256 as `0x${string}`,
      contenthash: row.ar_tx ? arweaveContenthash(row.ar_tx) : null,
    });
    await update(env, pollId, { tx_hash: tx, chain_id: ens.chainId, status: 'submitted', error: null }, now());

    // 4. Committed once the receipt says so; otherwise the next run looks again.
    const state = await waitForReceipt(ens, tx, deps.receiptWaitMs ?? 45_000);
    if (state === 'success') {
      const at = now().toISOString();
      await update(env, pollId, { status: 'committed', committed_at: at }, now());
      await recordChainCommit(env, row, ens.chainId, tx, at);
    } else if (state === 'reverted') {
      await update(env, pollId, { tx_hash: null, status: 'posted', error: `transaction ${tx} reverted` }, now());
    }
    row = (await getCommitment(env, pollId))!;
    return { status: row.status, row };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[archive] ${pollId}: commit failed:`, msg);
    await update(env, pollId, { error: msg.slice(0, 500) }, now());
    throw e;
  } finally {
    await env.DB.prepare('UPDATE wave_commitments SET lease_until = NULL WHERE poll_id = ?').bind(pollId).run();
  }
}

/**
 * Name the questions of waves that are open now and opened after
 * `ARCHIVE_SINCE`, so a wave's cast and page can carry its ENS name from the
 * start. A few per run; an already-named question costs one read.
 */
export async function nameOpenWaveQuestions(env: CommitEnv, deps: CommitDeps = {}, limit = 3): Promise<Array<{ question_id: string; status: string; error?: string }>> {
  if (!writesEnabled(env) || !env.ARCHIVE_SINCE) return [];
  const nowIso = (deps.now ?? (() => new Date()))().toISOString();
  const { results } = await env.DB.prepare(`
    SELECT question_id FROM polls
    WHERE julianday(closes_at) > julianday(?) AND julianday(created_at) > julianday(?)
    GROUP BY question_id
    ORDER BY MAX(created_at) DESC
    LIMIT ?
  `).bind(nowIso, env.ARCHIVE_SINCE, limit).all();
  const ens = deps.ens ?? sepoliaEns(env);
  const out: Array<{ question_id: string; status: string; error?: string }> = [];
  for (const { question_id } of (results || []) as Array<{ question_id: string }>) {
    try {
      out.push({ question_id, status: await ensureNamed(env, ens, question_id, deps) });
    } catch (e) {
      out.push({ question_id, status: 'error', error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

/**
 * The cron's pass: closed waves past `ARCHIVE_SINCE` without a committed
 * record, oldest close first, a few per run. Nothing is swept when
 * `ARCHIVE_SINCE` is unset: a wave closed before the audience chooser said
 * Public answers are archived is committed only by hand.
 */
export async function sweepClosedWaves(env: CommitEnv, deps: CommitDeps = {}, limit = 3): Promise<Array<{ poll_id: string; status: string; error?: string }>> {
  if (!writesEnabled(env) || !env.ARCHIVE_SINCE) return [];
  const nowIso = (deps.now ?? (() => new Date()))().toISOString();
  const { results } = await env.DB.prepare(`
    SELECT p.id FROM polls p
    LEFT JOIN wave_commitments c ON c.poll_id = p.id
    WHERE julianday(p.closes_at) <= julianday(?) AND julianday(p.closes_at) > julianday(?)
      AND (c.poll_id IS NULL OR c.status != 'committed')
    ORDER BY julianday(p.closes_at)
    LIMIT ?
  `).bind(nowIso, env.ARCHIVE_SINCE, limit).all();
  const out: Array<{ poll_id: string; status: string; error?: string }> = [];
  for (const { id } of (results || []) as Array<{ id: string }>) {
    try {
      out.push({ poll_id: id, status: (await commitWave(env, id, deps)).status });
    } catch (e) {
      out.push({ poll_id: id, status: 'error', error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}
