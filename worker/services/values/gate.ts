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
}

const ZERO_GATE: QQGateState = {
  unlocked: false,
  balance: '0',
  threshold: QQ_THRESHOLD_WEI.toString(),
  address: null,
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

export async function checkQQGate(env: Env, fid: number): Promise<QQGateState> {
  const neynar = await fetchNeynarUser(env, fid);
  if (!neynar) return ZERO_GATE;

  const addresses = collectAddresses(neynar);
  if (addresses.length === 0) return ZERO_GATE;

  const rpcUrl = (env.BASE_RPC_URL as string) || 'https://base.llamarpc.com';
  const client = createPublicClient({ chain: base, transport: http(rpcUrl) });

  let maxBalance = 0n;
  let maxAddress: string | null = null;
  for (const addr of addresses) {
    try {
      const bal = (await client.readContract({
        address: QQ_ADDRESS,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [addr as Hex],
      })) as bigint;
      if (bal > maxBalance) {
        maxBalance = bal;
        maxAddress = addr;
      }
    } catch (e) {
      console.error('[values gate] balanceOf failed for', addr, e);
    }
  }

  return {
    unlocked: maxBalance >= QQ_THRESHOLD_WEI,
    balance: maxBalance.toString(),
    threshold: QQ_THRESHOLD_WEI.toString(),
    address: maxAddress,
  };
}
