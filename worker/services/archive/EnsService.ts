/**
 * The question's ENS name on Sepolia ENSv2 (plan 2026-09-25 §7.2–§7.5).
 *
 * Reads go through the ENS Universal Resolver whose address viem ships for
 * Sepolia (never hardcoded here), so what the verify route sees is what any
 * ENS client sees. Writes are one `multicall` on qbase's PermissionedResolver
 * from the writer key, which holds setter roles only (SET_TEXT, SET_DATA,
 * SET_CONTENTHASH as root roles): it can write every record on every name the
 * resolver serves, and cannot grant, link, upgrade or register. Naming a
 * question stays with the deployer (`scripts/ens/setup.ts --question <id>`).
 *
 * Resolver setters take the DNS-encoded name, not a namehash (post-audit
 * interfaces; scripts/ens/README.md).
 */

import {
  createPublicClient,
  createWalletClient,
  decodeAbiParameters,
  encodeFunctionData,
  http,
  namehash,
  parseAbi,
  stringToBytes,
  toHex,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';

export const DEFAULT_SEPOLIA_RPC = 'https://ethereum-sepolia-rpc.publicnode.com';

const resolverAbi = parseAbi([
  'function setText(bytes name, string key, string value)',
  'function setData(bytes name, string key, bytes value)',
  'function setContenthash(bytes name, bytes hash)',
  'function multicall(bytes[] calls) returns (bytes[])',
]);
const universalResolverAbi = parseAbi([
  'function findResolver(bytes name) view returns (address resolver, bytes32 node, uint256 offset)',
  'function resolve(bytes name, bytes data) view returns (bytes, address)',
]);
// ENSIP-5 text and ENSIP-24 data, encoded as the `data` argument of resolve().
const recordAbi = parseAbi([
  'function text(bytes32 node, string key) view returns (string)',
  'function data(bytes32 node, string key) view returns (bytes)',
]);

export function dnsEncode(name: string): Hex {
  const parts: number[] = [];
  for (const label of name.split('.').filter(Boolean)) {
    const bytes = stringToBytes(label);
    if (bytes.length > 255) throw new Error(`label too long: ${label}`);
    parts.push(bytes.length, ...bytes);
  }
  parts.push(0);
  return toHex(Uint8Array.from(parts));
}

export interface WaveRecords {
  /** JSON array of committed wave ids on the question, this one included. */
  waves: string[];
  pollId: string;
  /** Canonical JSON for `qbase.wave.<id>`. */
  summary: string;
  /** 0x-prefixed sha256 of the bundle, for `qbase.wave.<id>.hash`. */
  bundleSha256: Hex;
  /** ENSIP-7 contenthash, when the bundle is on Arweave. */
  contenthash: Hex | null;
}

export type ReceiptState = 'success' | 'reverted' | 'pending';

/** What the commit job and the verify route need from ENS; the tests swap it for a fake. */
export interface EnsPort {
  chainId: number;
  /** The name has its own resolver and it is qbase's. */
  isNamed(name: string): Promise<boolean>;
  commit(name: string, records: WaveRecords): Promise<Hex>;
  receipt(tx: Hex): Promise<ReceiptState>;
  /** `qbase.wave.<id>.hash` as the Universal Resolver returns it; null when unset. */
  readWaveHash(name: string, pollId: string): Promise<Hex | null>;
  readText(name: string, key: string): Promise<string | null>;
}

export interface EnsEnv {
  ENS_WRITER_PRIVATE_KEY?: string;
  ENS_RESOLVER_ADDRESS?: string;
  SEPOLIA_RPC_URL?: string;
}

export function waveRecordCalls(name: string, r: WaveRecords): Hex[] {
  const dns = dnsEncode(name);
  const calls: Hex[] = [
    encodeFunctionData({ abi: resolverAbi, functionName: 'setText', args: [dns, 'qbase.waves', JSON.stringify(r.waves)] }),
    encodeFunctionData({ abi: resolverAbi, functionName: 'setText', args: [dns, `qbase.wave.${r.pollId}`, r.summary] }),
    encodeFunctionData({ abi: resolverAbi, functionName: 'setData', args: [dns, `qbase.wave.${r.pollId}.hash`, r.bundleSha256] }),
  ];
  if (r.contenthash) calls.push(encodeFunctionData({ abi: resolverAbi, functionName: 'setContenthash', args: [dns, r.contenthash] }));
  return calls;
}

export function sepoliaEns(env: EnsEnv): EnsPort {
  const transport = http(env.SEPOLIA_RPC_URL || DEFAULT_SEPOLIA_RPC);
  const client = createPublicClient({ chain: sepolia, transport });
  const universalResolver = sepolia.contracts.ensUniversalResolver.address as Address;
  const ours = (env.ENS_RESOLVER_ADDRESS || '').toLowerCase();

  async function resolveRecord(name: string, data: Hex): Promise<Hex | null> {
    try {
      const [result] = await client.readContract({
        address: universalResolver, abi: universalResolverAbi, functionName: 'resolve', args: [dnsEncode(name), data],
      });
      return result;
    } catch {
      return null; // no resolver, or the record resolves to nothing
    }
  }

  return {
    chainId: sepolia.id,
    async isNamed(name) {
      const [resolver, , offset] = await client.readContract({
        address: universalResolver, abi: universalResolverAbi, functionName: 'findResolver', args: [dnsEncode(name)],
      });
      return offset === 0n && !!ours && resolver.toLowerCase() === ours;
    },
    async commit(name, records) {
      if (!env.ENS_WRITER_PRIVATE_KEY || !ours) throw new Error('ENS_WRITER_PRIVATE_KEY and ENS_RESOLVER_ADDRESS are required');
      const key = env.ENS_WRITER_PRIVATE_KEY.startsWith('0x') ? env.ENS_WRITER_PRIVATE_KEY : `0x${env.ENS_WRITER_PRIVATE_KEY}`;
      const wallet = createWalletClient({ chain: sepolia, transport, account: privateKeyToAccount(key as Hex) });
      return wallet.writeContract({
        address: ours as Address, abi: resolverAbi, functionName: 'multicall', args: [waveRecordCalls(name, records)],
      });
    },
    async receipt(tx) {
      try {
        const r = await client.getTransactionReceipt({ hash: tx });
        return r.status === 'success' ? 'success' : 'reverted';
      } catch {
        return 'pending';
      }
    },
    async readWaveHash(name, pollId) {
      const data = encodeFunctionData({ abi: recordAbi, functionName: 'data', args: [namehash(name), `qbase.wave.${pollId}.hash`] });
      const raw = await resolveRecord(name, data);
      if (!raw) return null;
      const [value] = decodeAbiParameters([{ type: 'bytes' }], raw);
      return value === '0x' ? null : value;
    },
    async readText(name, key) {
      const data = encodeFunctionData({ abi: recordAbi, functionName: 'text', args: [namehash(name), key] });
      const raw = await resolveRecord(name, data);
      if (!raw) return null;
      const [value] = decodeAbiParameters([{ type: 'string' }], raw);
      return value || null;
    },
  };
}
