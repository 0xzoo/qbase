/**
 * OracleEscrowService — the $QQ stake users pay the council from.
 *
 * Wraps `OracleEscrow.sol` on Base (sibling Foundry project
 * `/Users/zoo/work/qbase/contracts/`, spec docs/specs/paid-council.md):
 *   availableBalance(fid)  — net stake (deposits − deductions), read
 *   cooldownRemaining(fid) — seconds until withdraw is allowed, read
 *   recordDeduction(fid, amount) — ledger entry, signed by the oracle-agent
 *                                  wallet (`ORACLE_AGENT_KEY`)
 *
 * Config: `ORACLE_ESCROW_ADDRESS` (var), `ORACLE_AGENT_KEY` (secret),
 * `BASE_RPC_URL` (var). `fromEnv` returns null while the contract address is
 * unset so callers can treat the gate as "not deployed yet".
 *
 * Balance reads are cached 30 s in KV_USER_PROFILES (`council:balance:<fid>`)
 * and invalidated by a deduction from this worker.
 */

import { createPublicClient, createWalletClient, http, parseAbi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

export const QQ_DECIMALS = 18;

export const ORACLE_ESCROW_ABI = parseAbi([
  'function availableBalance(uint256 fid) view returns (uint256)',
  'function cooldownRemaining(uint256 fid) view returns (uint256)',
  'function balances(uint256 fid) view returns (uint256)',
  'function totalDeducted(uint256 fid) view returns (uint256)',
  'function recordDeduction(uint256 fid, uint256 amount)',
  'function deposit(uint256 fid, uint256 amount)',
  'function withdraw(uint256 fid, uint256 amount)',
  'event DeductionRecorded(uint256 indexed fid, uint256 amount)',
]);

const BALANCE_CACHE_TTL_S = 30;

/** What CouncilService needs from an escrow; the real thing or a test stub. */
export interface EscrowLike {
  availableBalance(fid: number, opts?: { fresh?: boolean }): Promise<bigint>;
  recordDeduction(fid: number, amountWei: bigint): Promise<Hex>;
}

interface EscrowEnv {
  ORACLE_ESCROW_ADDRESS?: string;
  ORACLE_AGENT_KEY?: string;
  BASE_RPC_URL?: string;
  ALCHEMY_API_KEY?: string;
  KV_USER_PROFILES?: KVNamespace;
}

export class OracleEscrowService implements EscrowLike {
  private address: Hex;
  private rpcUrl: string;
  private agentKey?: Hex;
  private kv?: KVNamespace;

  constructor(opts: { address: string; rpcUrl: string; agentKey?: string; kv?: KVNamespace }) {
    this.address = opts.address as Hex;
    this.rpcUrl = opts.rpcUrl;
    this.agentKey = opts.agentKey as Hex | undefined;
    this.kv = opts.kv;
  }

  /** null until ORACLE_ESCROW_ADDRESS is set (contract not deployed / wired). */
  static fromEnv(env: EscrowEnv): OracleEscrowService | null {
    const address = env.ORACLE_ESCROW_ADDRESS;
    if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) return null;
    // Same RPC preference as quizAirdrop: Alchemy when keyed, else BASE_RPC_URL.
    const rpcUrl = env.ALCHEMY_API_KEY
      ? `https://base-mainnet.g.alchemy.com/v2/${env.ALCHEMY_API_KEY}`
      : env.BASE_RPC_URL || 'https://mainnet.base.org';
    return new OracleEscrowService({ address, rpcUrl, agentKey: env.ORACLE_AGENT_KEY, kv: env.KV_USER_PROFILES });
  }

  get contractAddress(): Hex {
    return this.address;
  }

  private publicClient() {
    return createPublicClient({ chain: base, transport: http(this.rpcUrl, { retryCount: 3, retryDelay: 500 }) });
  }

  private cacheKey(fid: number): string {
    return `council:balance:${fid}`;
  }

  async availableBalance(fid: number, opts?: { fresh?: boolean }): Promise<bigint> {
    const key = this.cacheKey(fid);
    if (!opts?.fresh && this.kv) {
      const cached = await this.kv.get(key);
      if (cached !== null) return BigInt(cached);
    }
    const value = await this.publicClient().readContract({
      address: this.address,
      abi: ORACLE_ESCROW_ABI,
      functionName: 'availableBalance',
      args: [BigInt(fid)],
    }) as bigint;
    if (this.kv) await this.kv.put(key, value.toString(), { expirationTtl: BALANCE_CACHE_TTL_S });
    return value;
  }

  async cooldownRemaining(fid: number): Promise<bigint> {
    return await this.publicClient().readContract({
      address: this.address,
      abi: ORACLE_ESCROW_ABI,
      functionName: 'cooldownRemaining',
      args: [BigInt(fid)],
    }) as bigint;
  }

  /**
   * Ledger a deduction against the FID's stake. Simulates first for a clear
   * revert reason (InsufficientBalance / OnlyOracleAgent), sends the tx, and
   * returns its hash without waiting for confirmation (Base blocks are ~2 s;
   * the balance cache is dropped so the next read reflects the pending state
   * once mined).
   */
  async recordDeduction(fid: number, amountWei: bigint): Promise<Hex> {
    if (!this.agentKey) throw new Error('ORACLE_AGENT_KEY not configured');
    if (amountWei <= 0n) throw new Error('deduction amount must be positive');

    const account = privateKeyToAccount(this.agentKey);
    const transport = http(this.rpcUrl, { retryCount: 3, retryDelay: 500 });
    const publicClient = createPublicClient({ chain: base, transport });
    const wallet = createWalletClient({ account, chain: base, transport });

    const { request } = await publicClient.simulateContract({
      account,
      address: this.address,
      abi: ORACLE_ESCROW_ABI,
      functionName: 'recordDeduction',
      args: [BigInt(fid), amountWei],
    });
    const hash = await wallet.writeContract(request);

    if (this.kv) await this.kv.delete(this.cacheKey(fid));
    return hash;
  }
}
