/**
 * TokenHolderSnapshotService — at poll-creation, snapshot ERC-20 holders
 * meeting a minimum-balance threshold and resolve them to Farcaster FIDs.
 * Sibling to NftHolderSnapshotService; output shape mirrors it (one
 * `snapshot_fids` list) so the runtime check is the same list lookup.
 *
 * Pipeline:
 *   1. viem readContract → decimals() and (best-effort) symbol()
 *   2. Compute min_balance_wei = parseUnits(min_balance, decimals)
 *   3. Alchemy `getOwnersForContract?withTokenBalances=true` paginated.
 *      Alchemy's NFT API endpoint returns ERC-20 owners + per-holder
 *      balances when `withTokenBalances=true` — well-defined for ERC-721
 *      and works for ERC-20 in practice.
 *   4. Filter holders where balance ≥ min_balance_wei
 *   5. Neynar bulk-by-address (350-batch) → FIDs, deduped
 *
 * v0 LIMITS (same shape as the NFT service): synchronous inside the
 * create-query handler, ~30s wall-clock ceiling on Workers, hard cap on
 * total scanned addresses. Async snapshot is a v1 problem.
 */

import { createPublicClient, http, parseUnits, type Hex } from 'viem';
import { base } from 'viem/chains';

const MAX_HOLDERS_SCANNED = 100_000;  // before filtering by balance
const NEYNAR_BATCH_SIZE = 350;

export interface TokenSnapshotInput {
  contract: string;     // 0x[a-fA-F0-9]{40}
  chain: 'base';
  /** Human-readable threshold the creator typed, e.g. "4420000" */
  min_balance: string;
}

export interface TokenSnapshotResult {
  /** Lowercased addresses that hold ≥ min_balance_wei */
  holderAddresses: string[];
  /** Deduped FIDs of qualifying holders with at least one Farcaster-verified address */
  holderFids: number[];
  /** Decimals fetched from the contract — cached on the gate for display */
  decimals: number;
  /** Symbol fetched from the contract — undefined if symbol() reverts */
  symbol?: string;
  /** parseUnits(min_balance, decimals).toString() — stored for audit */
  minBalanceWei: string;
  snapshottedAt: string;
}

interface AlchemyOwnersWithBalances {
  ownerAddresses?: Array<{
    ownerAddress: string;
    tokenBalances?: Array<{ contractAddress?: string; balance?: string }>;
  }>;
  pageKey?: string;
}

interface NeynarBulkByAddressResponse {
  [address: string]: Array<{ fid?: number }>;
}

const ERC20_DECIMALS_ABI = [
  { name: 'decimals', inputs: [], outputs: [{ type: 'uint8' }], stateMutability: 'view', type: 'function' },
] as const;
const ERC20_SYMBOL_ABI = [
  { name: 'symbol', inputs: [], outputs: [{ type: 'string' }], stateMutability: 'view', type: 'function' },
] as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

export async function snapshotTokenHolders(
  env: Env,
  { contract, chain, min_balance }: TokenSnapshotInput,
): Promise<TokenSnapshotResult> {
  if (!/^0x[a-fA-F0-9]{40}$/.test(contract)) {
    throw new Error(`Invalid contract address: ${contract}`);
  }
  if (chain !== 'base') {
    throw new Error(`Unsupported chain (v0 base-only): ${chain}`);
  }
  if (!/^\d+(\.\d+)?$/.test(min_balance) || Number(min_balance) <= 0) {
    throw new Error(`Invalid min_balance (must be positive number): ${min_balance}`);
  }
  if (!env.ALCHEMY_API_KEY) {
    throw new Error('ALCHEMY_API_KEY missing — cannot run token snapshot');
  }
  if (!env.NEYNAR_API_KEY) {
    throw new Error('NEYNAR_API_KEY missing — cannot resolve addresses to FIDs');
  }

  const rpcUrl = (env.BASE_RPC_URL as string | undefined) || 'https://base.llamarpc.com';
  const client = createPublicClient({ chain: base, transport: http(rpcUrl) });

  const decimals = await client.readContract({
    address: contract as Hex,
    abi: ERC20_DECIMALS_ABI,
    functionName: 'decimals',
  });

  // symbol() can revert on non-standard tokens — surface as undefined
  let symbol: string | undefined;
  try {
    symbol = await client.readContract({
      address: contract as Hex,
      abi: ERC20_SYMBOL_ABI,
      functionName: 'symbol',
    });
  } catch (err) {
    console.warn('[TokenHolderSnapshot] symbol() reverted, continuing without symbol:', err);
  }

  const minBalanceWei = parseUnits(min_balance, decimals);

  const qualifying = await fetchOwnersAboveThreshold(env, contract, minBalanceWei);
  const holderFids = await resolveAddressesToFids(env, qualifying);

  return {
    holderAddresses: qualifying,
    holderFids,
    decimals,
    symbol,
    minBalanceWei: minBalanceWei.toString(),
    snapshottedAt: new Date().toISOString(),
  };
}

async function fetchOwnersAboveThreshold(
  env: Env,
  contract: string,
  minBalanceWei: bigint,
): Promise<string[]> {
  const qualifying = new Set<string>();
  let scanned = 0;
  let pageKey: string | undefined;
  let pages = 0;
  const contractLc = contract.toLowerCase();

  do {
    const url = new URL(
      `https://base-mainnet.g.alchemy.com/nft/v3/${env.ALCHEMY_API_KEY}/getOwnersForContract`,
    );
    url.searchParams.set('contractAddress', contract);
    url.searchParams.set('withTokenBalances', 'true');
    if (pageKey) url.searchParams.set('pageKey', pageKey);

    const res = await fetch(url.toString());
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Alchemy getOwnersForContract failed (${res.status}): ${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as AlchemyOwnersWithBalances;

    for (const owner of data.ownerAddresses ?? []) {
      scanned++;
      if (scanned > MAX_HOLDERS_SCANNED) {
        throw new Error(
          `Scanned more than ${MAX_HOLDERS_SCANNED} holder rows — too large for v0 synchronous snapshot`,
        );
      }
      // Sum balances for this token contract across the holder's reported
      // entries. Alchemy typically returns one entry per (holder, contract);
      // we sum defensively in case of fragmented reporting. `BigInt()` parses
      // both hex (`0x…`) and decimal strings.
      let totalBalance = 0n;
      for (const tb of owner.tokenBalances ?? []) {
        if (tb.contractAddress && tb.contractAddress.toLowerCase() !== contractLc) continue;
        if (typeof tb.balance !== 'string') continue;
        try {
          totalBalance += BigInt(tb.balance);
        } catch {
          // ignore malformed balance string
        }
      }
      if (totalBalance >= minBalanceWei) {
        qualifying.add(owner.ownerAddress.toLowerCase());
      }
    }

    pageKey = data.pageKey;
    pages++;
    if (pages > 200) {
      throw new Error('Alchemy pagination did not terminate');
    }
  } while (pageKey);

  return Array.from(qualifying);
}

async function resolveAddressesToFids(env: Env, addresses: string[]): Promise<number[]> {
  if (addresses.length === 0) return [];
  const fids = new Set<number>();

  for (let i = 0; i < addresses.length; i += NEYNAR_BATCH_SIZE) {
    const batch = addresses.slice(i, i + NEYNAR_BATCH_SIZE);
    const url = `https://api.neynar.com/v2/farcaster/user/bulk-by-address?addresses=${batch.join(',')}`;
    const res = await fetch(url, {
      headers: {
        'x-api-key': env.NEYNAR_API_KEY,
        'x-neynar-experimental': 'true',
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Neynar bulk-by-address failed (${res.status}): ${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as NeynarBulkByAddressResponse;
    for (const users of Object.values(data)) {
      for (const u of users) {
        if (typeof u.fid === 'number') fids.add(u.fid);
      }
    }
  }
  return Array.from(fids).sort((a, b) => a - b);
}
