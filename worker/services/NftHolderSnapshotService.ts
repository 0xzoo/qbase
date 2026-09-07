/**
 * NftHolderSnapshotService — at poll-creation time, take a one-shot snapshot
 * of an NFT collection's holders and resolve them to Farcaster FIDs. The
 * resulting FID list is stored inline on `polls.eligibility_gate` so the
 * runtime eligibility check (per-vote) is a list lookup, not an RPC call.
 *
 * Pipeline:
 *   1. Alchemy `getOwnersForContract` (paginated) → unique holder addresses
 *   2. Neynar `bulk-by-address` (350-batch) → FIDs for verified addresses
 *   3. Dedupe FIDs (one FID can hold across multiple verified addresses)
 *
 * v0 LIMITS:
 *   - Synchronous, runs inside the create-query handler. Cloudflare Workers
 *     have a ~30s wall-clock ceiling on requests; collections with tens of
 *     thousands of holders will fail. Mitigation: hard cap (`MAX_HOLDERS`)
 *     and explicit error so the caller can decide. Durable-object-driven
 *     async snapshotting is a v1 problem.
 *   - Base only. The chain selector exists in the type but the URL builder
 *     hardcodes `base-mainnet`. Adding more chains is a one-line switch.
 */

const MAX_HOLDERS = 50_000;       // hard cap — refuse rather than time out
const NEYNAR_BATCH_SIZE = 350;    // Neynar bulk-by-address upper bound

export interface SnapshotInput {
  contract: string; // 0x[a-fA-F0-9]{40}
  chain: 'base';
}

export interface SnapshotResult {
  /** Lowercased, deduped holder addresses found onchain */
  holderAddresses: string[];
  /** Deduped FIDs of holders with at least one Farcaster-verified address */
  holderFids: number[];
  /** ISO timestamp when the snapshot finished */
  snapshottedAt: string;
}

interface AlchemyOwnersResponse {
  owners?: string[];
  pageKey?: string;
}

interface NeynarBulkByAddressResponse {
  // keyed by lowercase address → array of users (one address can be
  // verified by multiple FIDs in edge transitions)
  [address: string]: Array<{ fid?: number }>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

/**
 * Take a snapshot of NFT holders → FIDs. Throws on hard cap exceedance,
 * Alchemy/Neynar failures, or invalid input. Caller is responsible for
 * surfacing errors to the user — never write a partial snapshot.
 */
export async function snapshotNftHolders(
  env: Env,
  { contract, chain }: SnapshotInput,
): Promise<SnapshotResult> {
  if (!/^0x[a-fA-F0-9]{40}$/.test(contract)) {
    throw new Error(`Invalid contract address: ${contract}`);
  }
  if (chain !== 'base') {
    throw new Error(`Unsupported chain (v0 base-only): ${chain}`);
  }
  if (!env.ALCHEMY_API_KEY) {
    throw new Error('ALCHEMY_API_KEY missing — cannot run NFT snapshot');
  }
  if (!env.NEYNAR_API_KEY) {
    throw new Error('NEYNAR_API_KEY missing — cannot resolve addresses to FIDs');
  }

  const holderAddresses = await fetchAllOwners(env, contract);
  const holderFids = await resolveAddressesToFids(env, holderAddresses);

  return {
    holderAddresses,
    holderFids,
    snapshottedAt: new Date().toISOString(),
  };
}

async function fetchAllOwners(env: Env, contract: string): Promise<string[]> {
  const seen = new Set<string>();
  let pageKey: string | undefined;
  let pages = 0;

  do {
    const url = new URL(
      `https://base-mainnet.g.alchemy.com/nft/v3/${env.ALCHEMY_API_KEY}/getOwnersForContract`,
    );
    url.searchParams.set('contractAddress', contract);
    url.searchParams.set('withTokenBalances', 'false');
    if (pageKey) url.searchParams.set('pageKey', pageKey);

    const res = await fetch(url.toString());
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Alchemy getOwnersForContract failed (${res.status}): ${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as AlchemyOwnersResponse;

    for (const addr of data.owners ?? []) {
      seen.add(addr.toLowerCase());
      if (seen.size > MAX_HOLDERS) {
        throw new Error(
          `Collection has more than ${MAX_HOLDERS} holders — too large for v0 synchronous snapshot`,
        );
      }
    }

    pageKey = data.pageKey;
    pages++;
    if (pages > 200) {
      // Defensive: hitting this means something is wrong with pagination.
      throw new Error('Alchemy pagination did not terminate');
    }
  } while (pageKey);

  return Array.from(seen);
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
