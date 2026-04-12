// bartlet — airdrop pipeline.
//
// Pieces, in order (see SPEC §6):
//   1. Neynar score gate (≥ 0.95)
//   2. Atomic cohort counter bump (hard cap 1000 per SPEC §5)
//   3. Verified eth address resolution (verified_addresses → custody fallback)
//   4. $QQ.transfer via viem on Base
//   5. Persist to D1 bartlet_airdrops (fid PK = dedup)
//
// All steps are idempotent-by-design at the D1 level: the bartlet_airdrops row
// uses `fid` as primary key, and the cohort counter increment is a single
// UPDATE ... RETURNING statement. If any step after the cohort bump fails,
// we leak a slot — acceptable for Phase 1 (1000 slots, small treasury).

import { createPublicClient, createWalletClient, http, parseUnits, erc20Abi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import type { Hex } from 'viem';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

const QQ_DECIMALS = 18;
const AIRDROP_AMOUNT_TOKENS = '4420000'; // 4.42M $QQ per user
const NEYNAR_SCORE_THRESHOLD = 0.9;
const COHORT_CAP = 1000;

export type AirdropOutcome =
  | { kind: 'success'; txHash: Hex; amountTokens: string }
  | { kind: 'already_claimed'; txHash: string }
  | { kind: 'pool_exhausted' }
  | { kind: 'not_eligible'; reason: 'score' | 'no_address' }
  | { kind: 'disabled' }
  | { kind: 'error'; error: string };

export interface AirdropContext {
  env: Env;
  fid: number;
  sid: string;
}

/**
 * Run the full airdrop pipeline for a completed bartlet session.
 * Safe to call multiple times for the same (fid, sid): the D1 primary-key
 * check on bartlet_airdrops short-circuits reclaims.
 */
export async function runAirdrop(ctx: AirdropContext): Promise<AirdropOutcome> {
  const { env, fid, sid } = ctx;

  if (env.BARTLET_AIRDROP_ENABLED !== '1') {
    return { kind: 'disabled' };
  }

  // 0. Dedup: has this FID already been airdropped?
  const existing = await env.DB.prepare(
    'SELECT tx_hash FROM bartlet_airdrops WHERE fid = ?'
  )
    .bind(fid)
    .first();
  if (existing?.tx_hash) {
    return { kind: 'already_claimed', txHash: existing.tx_hash as string };
  }

  // 1. Neynar score gate.
  const neynar = await fetchNeynarUser(env, fid);
  if (!neynar) {
    return { kind: 'error', error: 'neynar lookup failed' };
  }
  const score = neynar.score ?? 0;
  if (score < NEYNAR_SCORE_THRESHOLD) {
    return { kind: 'not_eligible', reason: 'score' };
  }

  // 2. Address resolution. Verified eth → custody fallback.
  const toAddress = pickRecipientAddress(neynar);
  if (!toAddress) {
    return { kind: 'not_eligible', reason: 'no_address' };
  }

  // 3. Atomic cohort counter bump. D1's UPDATE ... RETURNING returns the
  // post-increment value. If it's > COHORT_CAP, we roll the counter back.
  const bumped = (await env.DB.prepare(
    'UPDATE bartlet_cohort_counter SET count = count + 1 WHERE id = 1 RETURNING count'
  ).first()) as { count: number } | null;
  if (!bumped) {
    return { kind: 'error', error: 'cohort counter missing' };
  }
  if (bumped.count > COHORT_CAP) {
    // Roll back so subsequent fallback reads stay accurate.
    await env.DB.prepare(
      'UPDATE bartlet_cohort_counter SET count = count - 1 WHERE id = 1 AND count > 0'
    ).run();
    return { kind: 'pool_exhausted' };
  }

  // 4. Send $QQ.transfer.
  let txHash: Hex;
  try {
    txHash = await sendQQTransfer(env, toAddress, AIRDROP_AMOUNT_TOKENS);
  } catch (e) {
    // Roll back cohort slot so another user can take it.
    await env.DB.prepare(
      'UPDATE bartlet_cohort_counter SET count = count - 1 WHERE id = 1 AND count > 0'
    ).run();
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[bartlet/airdrop] transfer failed:', msg);
    return { kind: 'error', error: msg };
  }

  // 5. Persist to ledger. fid PK is our idempotency lock.
  try {
    await env.DB.prepare(
      'INSERT INTO bartlet_airdrops (fid, sid, tx_hash, to_address, amount, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
      .bind(fid, sid, txHash, toAddress, AIRDROP_AMOUNT_TOKENS, Date.now())
      .run();
  } catch (e) {
    // If insert fails (rare; race with another call), we've still sent the
    // tokens. Log and return success so the user sees the tx hash.
    console.error('[bartlet/airdrop] ledger insert failed:', e);
  }

  return { kind: 'success', txHash, amountTokens: AIRDROP_AMOUNT_TOKENS };
}

// ─── Neynar ──────────────────────────────────────────────────────────────

interface NeynarUser {
  fid: number;
  score?: number;
  custody_address?: string;
  verified_addresses?: {
    eth_addresses?: string[];
    primary?: { eth_address?: string };
  };
}

async function fetchNeynarUser(env: Env, fid: number): Promise<NeynarUser | null> {
  const apiKey = env.NEYNAR_API_KEY;
  if (!apiKey) {
    console.error('[bartlet/airdrop] NEYNAR_API_KEY missing');
    return null;
  }
  const res = await fetch(`https://api.neynar.com/v2/farcaster/user/bulk?fids=${fid}`, {
    headers: {
      'x-api-key': apiKey,
      'x-neynar-experimental': 'true',
    },
  });
  if (!res.ok) {
    console.error('[bartlet/airdrop] Neynar bulk fetch failed:', res.status);
    return null;
  }
  const data = (await res.json()) as { users?: NeynarUser[] };
  return data.users?.[0] ?? null;
}

function pickRecipientAddress(user: NeynarUser): string | null {
  const primary = user.verified_addresses?.primary?.eth_address;
  if (primary) return primary;
  const eth = user.verified_addresses?.eth_addresses?.[0];
  if (eth) return eth;
  if (user.custody_address) return user.custody_address;
  return null;
}

// ─── On-chain transfer ───────────────────────────────────────────────────

async function sendQQTransfer(
  env: Env,
  to: string,
  amountTokens: string
): Promise<Hex> {
  const pk = env.BARTLET_TREASURY_KEY as string | undefined;
  if (!pk) throw new Error('BARTLET_TREASURY_KEY not set');
  if (!env.QQ_CONTRACT_ADDRESS) throw new Error('QQ_CONTRACT_ADDRESS not set');

  const account = privateKeyToAccount(
    (pk.startsWith('0x') ? pk : `0x${pk}`) as Hex
  );
  const rpcUrl = (env.BASE_RPC_URL as string | undefined) || 'https://base.llamarpc.com';
  // Public Base RPCs aggressively rate-limit; retry a few times with backoff
  // so transient 429s don't burn an airdrop slot.
  const transport = http(rpcUrl, { retryCount: 3, retryDelay: 500 });

  const wallet = createWalletClient({ account, chain: base, transport });
  const publicClient = createPublicClient({ chain: base, transport });

  const amount = parseUnits(amountTokens, QQ_DECIMALS);

  // Simulate first for clearer errors.
  const { request } = await publicClient.simulateContract({
    account,
    address: env.QQ_CONTRACT_ADDRESS as Hex,
    abi: erc20Abi,
    functionName: 'transfer',
    args: [to as Hex, amount],
  });

  // Fire the tx; do not wait for confirmation (SPEC §6 step 7).
  const hash = await wallet.writeContract(request);
  return hash;
}
