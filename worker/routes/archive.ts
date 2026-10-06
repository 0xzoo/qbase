/**
 * Committed wave records (plan 2026-09-25 §7.5).
 *
 *   GET  /api/archive/waves/:id          the commitment: ENS name, tx, bundle link
 *   GET  /api/archive/waves/:id/bundle   the committed bundle bytes (the §7.4
 *                                        fallback when Arweave is unavailable)
 *   GET  /api/archive/waves/:id/verify   two checks:
 *     chain.matches  the bundle, fetched back from Arweave (or qbase when it
 *                    never reached Arweave), hashes to `qbase.wave.<id>.hash`
 *                    as read through the ENS Universal Resolver. Stays true.
 *     live.matches   the wave's tally recomputed from D1 now equals the tally
 *                    in that bundle. Flips to false the moment a row changes.
 *   POST /api/admin/archive/waves/:id/commit   run archive:commit now (X-Admin-Secret)
 *   POST /api/admin/archive/sweep              one cron pass now: name open waves'
 *                                              questions, commit closed waves (X-Admin-Secret)
 */

import { getPoll } from '../services/PollService';
import { canonicalJson, sha256Hex } from '../services/archive/canonicalJson';
import { liveTally, type WaveBundle, type WaveTally } from '../services/archive/WaveBundle';
import { fetchFromArweave } from '../services/archive/ArweaveService';
import { sepoliaEns, type EnsPort } from '../services/archive/EnsService';
import { bundleUrl, commitWave, getCommitment, listChainCommits, nameOpenWaveQuestions, sweepClosedWaves, writesEnabled, type CommitEnv, type CommitmentRow } from '../services/archive/WaveCommitJob';
import { sepolia } from 'viem/chains';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

export interface ArchiveRouteDeps {
  ens?: EnsPort;
  fetch?: typeof fetch;
}

const txUrl = (row: CommitmentRow) =>
  row.tx_hash ? `${row.chain_id === sepolia.id || row.chain_id == null ? 'https://sepolia.etherscan.io' : 'https://etherscan.io'}/tx/${row.tx_hash}` : null;

export function publicCommitment(env: Env, row: CommitmentRow) {
  return {
    poll_id: row.poll_id,
    question_id: row.question_id,
    status: row.status,
    ens_name: row.ens_name,
    chain_id: row.chain_id,
    tx_hash: row.tx_hash,
    tx_url: txUrl(row),
    ar_tx: row.ar_tx,
    // Turbo serves an item before it settles into an Arweave block: "posted", not "mined".
    arweave: row.ar_tx ? 'posted' : null,
    bundle_url: bundleUrl(env, row),
    // turbo-gateway.com serves the item at once; arweave.net only after it settles into a block
    bundle_http_url: row.ar_tx ? `https://turbo-gateway.com/${row.ar_tx}` : bundleUrl(env, row),
    bundle_sha256: row.bundle_sha256,
    committed_tally: JSON.parse(row.committed_tally) as WaveTally,
    committed_at: row.committed_at,
  };
}

function isAdmin(request: Request, env: Env): boolean {
  return !!env.QBASE_ADMIN_SECRET && request.headers.get('X-Admin-Secret') === env.QBASE_ADMIN_SECRET;
}

async function verify(env: Env, row: CommitmentRow, deps: ArchiveRouteDeps) {
  // The bundle as a reader would get it: from Arweave when it went there.
  let bundleText: string | null = null;
  let source: string;
  if (row.ar_tx) {
    const got = await fetchFromArweave(row.ar_tx, deps.fetch);
    bundleText = got?.text ?? null;
    source = got ? `${got.gateway}/${row.ar_tx}` : `ar://${row.ar_tx} (no gateway answered)`;
  } else {
    bundleText = row.bundle_json;
    source = bundleUrl(env, row);
  }
  const recomputed = bundleText !== null ? await sha256Hex(bundleText) : null;

  const ens = deps.ens ?? sepoliaEns(env);
  let onchain: string | null = null;
  let chainError: string | undefined;
  try {
    onchain = await ens.readWaveHash(row.ens_name, row.poll_id);
  } catch (e) {
    chainError = e instanceof Error ? e.message : String(e);
  }

  // Three answers, not two: `false` is reserved for "the chain was read and
  // disagrees" (a record missing from the name, or a different hash). When the
  // bundle could not be fetched or the RPC could not be reached, nothing was
  // checked, and `matches` is null with the reason in `status`.
  let chainStatus: 'verified' | 'mismatch' | 'unrecorded' | 'bundle_unavailable' | 'chain_unavailable';
  if (recomputed === null) chainStatus = 'bundle_unavailable';
  else if (chainError !== undefined) chainStatus = 'chain_unavailable';
  else if (onchain === null) chainStatus = 'unrecorded';
  else chainStatus = recomputed.toLowerCase() === onchain.toLowerCase() ? 'verified' : 'mismatch';
  const chainMatches: boolean | null =
    chainStatus === 'verified' ? true : chainStatus === 'mismatch' || chainStatus === 'unrecorded' ? false : null;

  // Live: compare against the tally inside the bundle the chain vouches for.
  let committed: WaveTally = JSON.parse(row.committed_tally);
  if (chainMatches && bundleText) committed = (JSON.parse(bundleText) as WaveBundle).tally;
  const poll = await getPoll(env.DB, row.poll_id);
  const now = poll ? await liveTally(env, poll) : null;
  const liveMatches = !!now && canonicalJson(now) === canonicalJson(committed);

  return {
    poll_id: row.poll_id,
    ens_name: row.ens_name,
    chain: {
      matches: chainMatches,
      status: chainStatus,
      bundle_source: source,
      bundle_sha256: recomputed,
      onchain_sha256: onchain,
      record: `qbase.wave.${row.poll_id}.hash`,
      read_via: `ENS Universal Resolver ${sepolia.contracts.ensUniversalResolver.address} (Sepolia)`,
      tx_url: txUrl(row),
      ...(chainError ? { error: chainError } : {}),
    },
    live: {
      matches: liveMatches,
      committed,
      now,
    },
    checked_at: new Date().toISOString(),
  };
}

export async function handleArchiveRoutes(request: Request, env: Env, deps: ArchiveRouteDeps = {}): Promise<Response | null> {
  const url = new URL(request.url);

  if (url.pathname === '/api/admin/archive/sweep' && request.method === 'POST') {
    if (!isAdmin(request, env)) return Response.json({ error: 'Forbidden' }, { status: 403 });
    const named = await nameOpenWaveQuestions(env as CommitEnv, deps);
    return Response.json({ enabled: writesEnabled(env), since: env.ARCHIVE_SINCE ?? null, named, results: await sweepClosedWaves(env as CommitEnv, deps) });
  }

  const admin = url.pathname.match(/^\/api\/admin\/archive\/waves\/([^/]+)\/commit$/);
  if (admin && request.method === 'POST') {
    if (!isAdmin(request, env)) return Response.json({ error: 'Forbidden' }, { status: 403 });
    try {
      const out = await commitWave(env as CommitEnv, decodeURIComponent(admin[1]), deps);
      return Response.json('row' in out ? { status: out.status, commitment: publicCommitment(env, out.row), error: out.row.error, ar_error: out.row.ar_error } : out);
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
    }
  }

  const m = url.pathname.match(/^\/api\/archive\/waves\/([^/]+)(\/bundle|\/verify)?$/);
  if (!m || request.method !== 'GET') return null;
  const pollId = decodeURIComponent(m[1]);
  let row: CommitmentRow | null = null;
  try {
    row = await getCommitment(env, pollId);
  } catch {
    row = null; // no wave_commitments table (0075 not applied): nothing is committed
  }

  if (!m[2]) {
    if (!row) return Response.json({ poll_id: pollId, status: 'none' }, { status: 404 });
    // Every chain the record is on (0077): Sepolia now, mainnet once ENSv2 launches and the tree is recreated.
    const chains = await listChainCommits(env, pollId);
    return Response.json({ ...publicCommitment(env, row), chains }, { headers: { 'Cache-Control': 'public, max-age=30' } });
  }
  if (!row) return Response.json({ error: 'no committed record for this poll' }, { status: 404 });

  if (m[2] === '/bundle') {
    return new Response(row.bundle_json, {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Bundle-SHA256': row.bundle_sha256,
      },
    });
  }

  return Response.json(await verify(env, row, deps), { headers: { 'Cache-Control': 'no-store' } });
}
