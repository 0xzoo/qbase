// Generalized quiz airdrop pipeline. Originated as bartlet/airdrop.ts and
// extracted here so values + hot takes + future bespoke quizzes can share
// the same flow without duplicating code.
//
// Pieces, in order:
//   1. Per-quiz dedup (quiz_airdrops PK = (quiz_id, fid))
//   2. Neynar score gate
//   3. Verified eth address resolution (verified_addresses → custody fallback)
//   4. Atomic cohort counter bump + cap check
//   5. $QQ.distribute via the AirdropVault on Base
//   6. Persist to quiz_airdrops ledger
//
// All steps are idempotent at the D1 level: the (quiz_id, fid) primary key
// short-circuits reclaims, and the cohort bump is a single UPDATE ... RETURNING
// that gets rolled back if the cap is exceeded or the transfer fails.

import { createPublicClient, createWalletClient, http, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import type { Hex } from 'viem';
import { fetchNeynarUser, type NeynarUser } from './NeynarUserService';
import { userKeyForFid } from './accounts/AccountService';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

const QQ_DECIMALS = 18;

export interface QuizAirdropConfig {
  quizId: string;
  enabled: boolean;
  amountTokens: string; // whole-token string, e.g. '4420000'
  neynarScoreThreshold: number;
  // Cohort cap is read from quiz_cohort_counters at migration time. The
  // config carries it so callers can branch on cap-exhaustion logic without
  // a separate read.
  cohortCap: number;
}

export interface AirdropContext {
  /**
   * The taker's Farcaster fid: the Neynar gate and the payout address come
   * from it. 0 for an account with no fid (no verified address → skipped).
   * The dedup key (quiz_airdrops.fid) is the person key derived from it.
   */
  fid: number;
  sid: string;
}

export type AirdropOutcome =
  | { kind: 'success'; txHash: Hex; amountTokens: string }
  | { kind: 'already_claimed'; txHash: string }
  | { kind: 'pool_exhausted' }
  | { kind: 'not_eligible'; reason: 'score' | 'no_address' }
  | { kind: 'disabled' }
  | { kind: 'error'; error: string };

export async function runQuizAirdrop(
  env: Env,
  config: QuizAirdropConfig,
  ctx: AirdropContext,
): Promise<AirdropOutcome> {
  if (!config.enabled) return { kind: 'disabled' };

  // An account with no Farcaster fid has no verified address to pay out to.
  if (!ctx.fid) return { kind: 'not_eligible', reason: 'no_address' };

  // quiz_airdrops.fid is a person key (account-root §5): the fid before the
  // cutover, the account id after. Neynar + the payout address stay on the fid.
  const userKey = await userKeyForFid(env, ctx.fid);

  // 1. Dedup: has this person already been airdropped for this quiz?
  const existing = await env.DB.prepare(
    'SELECT tx_hash FROM quiz_airdrops WHERE quiz_id = ? AND fid = ?',
  )
    .bind(config.quizId, userKey)
    .first();
  if (existing?.tx_hash) {
    return { kind: 'already_claimed', txHash: existing.tx_hash as string };
  }

  // 2. Neynar score gate.
  const neynar = await fetchNeynarUser(env, ctx.fid);
  if (!neynar) {
    return { kind: 'error', error: 'neynar lookup failed' };
  }
  if ((neynar.score ?? 0) < config.neynarScoreThreshold) {
    return { kind: 'not_eligible', reason: 'score' };
  }

  // 3. Address resolution.
  const toAddress = pickRecipientAddress(neynar);
  if (!toAddress) {
    return { kind: 'not_eligible', reason: 'no_address' };
  }

  // 4. Atomic cohort counter bump. UPDATE ... RETURNING gives us the post-
  // increment value in one round-trip. If we exceed the cap, roll back so
  // the slot is available for the next caller.
  const bumped = (await env.DB.prepare(
    'UPDATE quiz_cohort_counters SET count = count + 1 WHERE quiz_id = ? RETURNING count',
  )
    .bind(config.quizId)
    .first()) as { count: number } | null;
  if (!bumped) {
    return { kind: 'error', error: 'cohort counter missing' };
  }
  if (bumped.count > config.cohortCap) {
    await env.DB.prepare(
      'UPDATE quiz_cohort_counters SET count = count - 1 WHERE quiz_id = ? AND count > 0',
    )
      .bind(config.quizId)
      .run();
    return { kind: 'pool_exhausted' };
  }

  // 5. Send the $QQ transfer. If this throws, roll the counter back so
  // another user can take the slot.
  let txHash: Hex;
  try {
    txHash = await sendQQTransfer(env, toAddress, config.amountTokens);
  } catch (e) {
    await env.DB.prepare(
      'UPDATE quiz_cohort_counters SET count = count - 1 WHERE quiz_id = ? AND count > 0',
    )
      .bind(config.quizId)
      .run();
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[quizAirdrop/${config.quizId}] transfer failed:`, msg);
    return { kind: 'error', error: msg };
  }

  // 6. Persist to the ledger. The (quiz_id, fid) PK is our idempotency lock
  // — a race that doubles up here will fail the second insert, but tokens
  // were already sent, so we still log + return success.
  try {
    await env.DB.prepare(
      'INSERT INTO quiz_airdrops (quiz_id, fid, sid, tx_hash, to_address, amount, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(
        config.quizId,
        userKey,
        ctx.sid,
        txHash,
        toAddress,
        config.amountTokens,
        Date.now(),
      )
      .run();
  } catch (e) {
    console.error(`[quizAirdrop/${config.quizId}] ledger insert failed:`, e);
  }

  return { kind: 'success', txHash, amountTokens: config.amountTokens };
}

export function pickRecipientAddress(user: NeynarUser): string | null {
  const primary = user.verified_addresses?.primary?.eth_address;
  if (primary) return primary;
  const eth = user.verified_addresses?.eth_addresses?.[0];
  if (eth) return eth;
  if (user.custody_address) return user.custody_address;
  return null;
}

// ─── On-chain transfer via the AirdropVault contract ─────────────────────

const vaultAbi = [
  {
    name: 'distribute',
    type: 'function',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const;

async function sendQQTransfer(
  env: Env,
  to: string,
  amountTokens: string,
): Promise<Hex> {
  const pk = env.BARTLET_TREASURY_KEY as string | undefined;
  if (!pk) throw new Error('BARTLET_TREASURY_KEY not set');
  if (!env.AIRDROP_VAULT_ADDRESS) throw new Error('AIRDROP_VAULT_ADDRESS not set');

  const account = privateKeyToAccount(
    (pk.startsWith('0x') ? pk : `0x${pk}`) as Hex,
  );
  // Prefer Alchemy (same as the QQ gate) — the public llamarpc endpoint has been
  // returning HTTP 526 and silently failing the distribute() call, so the airdrop
  // never sends. Fall back to BASE_RPC_URL, then a stable public node.
  const alchemyKey = (env as { ALCHEMY_API_KEY?: string }).ALCHEMY_API_KEY;
  const rpcUrl = alchemyKey
    ? `https://base-mainnet.g.alchemy.com/v2/${alchemyKey}`
    : (env.BASE_RPC_URL as string | undefined) || 'https://mainnet.base.org';
  // Public Base RPCs aggressively rate-limit; retry a few times with backoff
  // so transient 429s don't burn an airdrop slot.
  const transport = http(rpcUrl, { retryCount: 3, retryDelay: 500 });

  const wallet = createWalletClient({ account, chain: base, transport });
  const publicClient = createPublicClient({ chain: base, transport });

  const amount = parseUnits(amountTokens, QQ_DECIMALS);

  // Simulate first for clearer errors.
  const { request } = await publicClient.simulateContract({
    account,
    address: env.AIRDROP_VAULT_ADDRESS as Hex,
    abi: vaultAbi,
    functionName: 'distribute',
    args: [to as Hex, amount],
  });

  // Fire the tx; do not wait for confirmation.
  const hash = await wallet.writeContract(request);
  return hash;
}
