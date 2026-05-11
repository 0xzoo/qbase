// values — live $QQ-balance gate.
//
// At result-page render time we resolve the user's verified Base addresses
// via Neynar (primary + eth_addresses + custody fallback) and read the
// balance for each from the $QQ ERC-20 on Base. Max balance across the
// addresses is compared against the 4.42M threshold.
//
// The gate is for *display* (per-dim narratives, context-card export panel
// state). The export endpoint itself (task #7) re-checks at request time, so
// a user spoofing the client can only see narratives, not pull the export.

import { createPublicClient, erc20Abi, http, parseUnits, type Hex } from 'viem';
import { base } from 'viem/chains';
import { fetchNeynarUser, type NeynarUser } from '../NeynarUserService';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

// $QQ token on Base — same address used in src/pages/BartletUnlock.tsx.
const QQ_ADDRESS = '0x7d39833d9d5baa835ba19e964e4ba114521ccfe4' as const;
const QQ_DECIMALS = 18;

// 4.42M $QQ — matches the bartlet airdrop amount. See SPEC §6.
export const QQ_THRESHOLD_WEI = parseUnits('4420000', QQ_DECIMALS);

export interface QQGateState {
  unlocked: boolean;
  balance: string;   // wei, stringified to survive JSON
  threshold: string; // wei, stringified
  address: string | null; // address holding the max balance, null if none
  // Per-address inspection so the UI can show the user which wallets we
  // checked. Helpful when the user knows they hold $QQ but the gate
  // disagrees — usually means the $QQ is in a wallet not verified to FC.
  inspected?: Array<{ address: string; balance: string }>;
  // Set when every balanceOf call threw (RPC down). UI can suggest a retry
  // rather than implying the user really holds 0.
  rpcError?: boolean;
}

const ZERO_GATE: QQGateState = {
  unlocked: false,
  balance: '0',
  threshold: QQ_THRESHOLD_WEI.toString(),
  address: null,
  inspected: [],
};

function collectAddresses(user: NeynarUser): string[] {
  const list: string[] = [];
  const primary = user.verified_addresses?.primary?.eth_address;
  if (primary) list.push(primary);
  for (const a of user.verified_addresses?.eth_addresses ?? []) list.push(a);
  if (user.custody_address) list.push(user.custody_address);
  // Dedupe (case-insensitive) while preserving discovery order.
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const a of list) {
    const k = a.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(a);
  }
  return unique;
}

function resolveRpcUrl(env: Env): string {
  const alchemyKey = (env as { ALCHEMY_API_KEY?: string }).ALCHEMY_API_KEY;
  if (alchemyKey) {
    return `https://base-mainnet.g.alchemy.com/v2/${alchemyKey}`;
  }
  return (env.BASE_RPC_URL as string) || 'https://mainnet.base.org';
}

export async function checkQQGate(env: Env, fid: number): Promise<QQGateState> {
  const neynar = await fetchNeynarUser(env, fid);
  if (!neynar) {
    console.warn(`[values gate] Neynar lookup failed for fid=${fid}`);
    return ZERO_GATE;
  }

  const addresses = collectAddresses(neynar);
  if (addresses.length === 0) {
    console.warn(`[values gate] fid=${fid} has no verified or custody addresses`);
    return ZERO_GATE;
  }

  const rpcUrl = resolveRpcUrl(env);
  const client = createPublicClient({ chain: base, transport: http(rpcUrl) });

  let maxBalance = 0n;
  let maxAddress: string | null = null;
  let errorCount = 0;
  const inspected: Array<{ address: string; balance: string }> = [];

  for (const addr of addresses) {
    try {
      const bal = (await client.readContract({
        address: QQ_ADDRESS,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [addr as Hex],
      })) as bigint;
      inspected.push({ address: addr, balance: bal.toString() });
      if (bal > maxBalance) {
        maxBalance = bal;
        maxAddress = addr;
      }
    } catch (e) {
      errorCount++;
      inspected.push({ address: addr, balance: 'error' });
      console.error('[values gate] balanceOf failed for', addr, e);
    }
  }

  console.log(
    `[values gate] fid=${fid} addresses=${addresses.length} max=${maxBalance.toString()} wei via=${rpcUrl.includes('alchemy') ? 'alchemy' : rpcUrl.includes('llamarpc') ? 'llamarpc' : 'public'}`,
  );

  return {
    unlocked: maxBalance >= QQ_THRESHOLD_WEI,
    balance: maxBalance.toString(),
    threshold: QQ_THRESHOLD_WEI.toString(),
    address: maxAddress,
    inspected,
    rpcError: errorCount === addresses.length,
  };
}
