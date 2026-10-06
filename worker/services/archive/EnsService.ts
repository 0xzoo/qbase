/**
 * The question's ENS name on Sepolia ENSv2 (plan 2026-09-25 §7.2–§7.5).
 *
 * Reads go through the ENS Universal Resolver whose address viem ships for
 * Sepolia (never hardcoded here), so what the verify route sees is what any
 * ENS client sees. Writes are one `multicall` on qbase's PermissionedResolver
 * from the writer key, which holds setter roles only (SET_TEXT, SET_DATA,
 * SET_CONTENTHASH as root roles): it can write every record on every name the
 * resolver serves, and cannot grant, link, upgrade or register.
 *
 * Naming a question is a third key, the **namer**, holding only ROLE_REGISTRAR
 * on UserRegistry(q.askqbase.eth) (`scripts/ens/grant-namer.ts`). ENSv2's
 * PermissionedRegistry._register reverts on a registered label, so the namer
 * can create new question names and cannot alter an existing one. The name is
 * registered exactly as setup.ts does it: owner = the deployer, qbase's
 * resolver, max expiry, and only SET_RESOLVER (+ its admin) on the token.
 *
 * Resolver setters take the DNS-encoded name, not a namehash (post-audit
 * interfaces; scripts/ens/README.md).
 */

import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  createPublicClient,
  createWalletClient,
  decodeAbiParameters,
  sha256,
  zeroAddress,
  encodeFunctionData,
  http,
  keccak256,
  namehash,
  parseAbi,
  stringToBytes,
  toHex,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
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
const registryAbi = parseAbi([
  'function register(string label, address owner, address registry, address resolver, uint256 roleBitmap, uint64 expiry) returns (uint256)',
]);
// scripts/ens/lib.ts QUESTION_ROLES: SET_RESOLVER and its admin bit; no transfer, subregistry or renew.
const SET_RESOLVER = 1n << 24n;
export const QUESTION_ROLES = SET_RESOLVER | (SET_RESOLVER << 128n);
export const MAX_EXPIRY = (1n << 64n) - 1n;
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

/**
 * `pending` covers "not mined yet" and "the node could not be asked" (an RPC
 * outage must never look like a dropped transaction); `dropped` means the node
 * answered and knows neither a receipt nor the transaction itself.
 */
export type ReceiptState = 'success' | 'reverted' | 'pending' | 'dropped';

/** `qbase.question` + `qbase.canonical`, exactly as setup.ts writes them. */
export function questionRecordCalls(name: string, question: { id: string; stem: string }): Hex[] {
  const dns = dnsEncode(name);
  return [
    encodeFunctionData({ abi: resolverAbi, functionName: 'setText', args: [dns, 'qbase.question', question.stem] }),
    encodeFunctionData({ abi: resolverAbi, functionName: 'setText', args: [dns, 'qbase.canonical', JSON.stringify({ id: question.id, sha256: sha256(stringToBytes(question.stem)) })] }),
  ];
}

/** What the commit job and the verify route need from ENS; the tests swap it for a fake. */
export interface EnsPort {
  chainId: number;
  /** The name has its own resolver and it is qbase's. */
  isNamed(name: string): Promise<boolean>;
  /** Whether a namer key is configured (else a question waits for setup.ts). */
  canName(): boolean;
  /** Register `<label>.<questions name>` from the namer key; returns the tx. */
  register(label: string): Promise<Hex>;
  /** Write qbase.question + qbase.canonical from the writer; returns the tx. */
  writeQuestionRecords(name: string, question: { id: string; stem: string }): Promise<Hex>;
  /**
   * One multicall of the wave's records from the writer. `onSigned` runs with
   * the transaction hash after signing and before broadcast, so the caller can
   * record the hash first: a worker that dies in between leaves a hash the next
   * run finds dropped and re-sends, instead of no hash and a second send.
   */
  commit(name: string, records: WaveRecords, onSigned?: (tx: Hex) => Promise<void>): Promise<Hex>;
  receipt(tx: Hex): Promise<ReceiptState>;
  /** `qbase.wave.<id>.hash` as the Universal Resolver returns it; null when unset. */
  readWaveHash(name: string, pollId: string): Promise<Hex | null>;
  readText(name: string, key: string): Promise<string | null>;
}

export interface EnsEnv {
  ENS_WRITER_PRIVATE_KEY?: string;
  /** ROLE_REGISTRAR on UserRegistry(q.askqbase.eth) only. */
  ENS_NAMER_PRIVATE_KEY?: string;
  /** UserRegistry(q.askqbase.eth). */
  ENS_QUESTION_REGISTRY?: string;
  /** Who owns question name tokens (the deployer, as in setup.ts). */
  ENS_NAME_OWNER?: string;
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

/** The node ran the call and the contract reverted or returned nothing (vs. the node could not be asked). */
function isContractAnswer(e: unknown): boolean {
  if (!(e instanceof ContractFunctionExecutionError)) return false;
  const cause = e.cause as unknown;
  return cause instanceof ContractFunctionRevertedError || cause instanceof ContractFunctionZeroDataError;
}

export function sepoliaEns(env: EnsEnv): EnsPort {
  const transport = http(env.SEPOLIA_RPC_URL || DEFAULT_SEPOLIA_RPC);
  const client = createPublicClient({ chain: sepolia, transport });
  const universalResolver = sepolia.contracts.ensUniversalResolver.address as Address;
  const ours = (env.ENS_RESOLVER_ADDRESS || '').toLowerCase();

  /**
   * A record through the Universal Resolver. Null when the chain answered and
   * there is nothing there (no resolver for the name, or an empty record): a
   * fact about the name. An RPC that could not be reached throws, so a verify
   * during an outage reads "unavailable", not "no record".
   */
  async function resolveRecord(name: string, data: Hex): Promise<Hex | null> {
    try {
      const [result] = await client.readContract({
        address: universalResolver, abi: universalResolverAbi, functionName: 'resolve', args: [dnsEncode(name), data],
      });
      return result;
    } catch (e) {
      if (isContractAnswer(e)) return null;
      throw e;
    }
  }

  const walletFor = (secret: string | undefined, what: string) => {
    if (!secret) throw new Error(`${what} is not set`);
    const key = (secret.startsWith('0x') ? secret : `0x${secret}`) as Hex;
    return createWalletClient({ chain: sepolia, transport, account: privateKeyToAccount(key) });
  };

  return {
    chainId: sepolia.id,
    canName() {
      return !!env.ENS_NAMER_PRIVATE_KEY && !!env.ENS_QUESTION_REGISTRY && !!env.ENS_NAME_OWNER && !!ours;
    },
    async register(label) {
      const wallet = walletFor(env.ENS_NAMER_PRIVATE_KEY, 'ENS_NAMER_PRIVATE_KEY');
      return wallet.writeContract({
        address: env.ENS_QUESTION_REGISTRY as Address, abi: registryAbi, functionName: 'register',
        args: [label, env.ENS_NAME_OWNER as Address, zeroAddress, ours as Address, QUESTION_ROLES, MAX_EXPIRY],
      });
    },
    async writeQuestionRecords(name, question) {
      const wallet = walletFor(env.ENS_WRITER_PRIVATE_KEY, 'ENS_WRITER_PRIVATE_KEY');
      return wallet.writeContract({
        address: ours as Address, abi: resolverAbi, functionName: 'multicall', args: [questionRecordCalls(name, question)],
      });
    },
    async isNamed(name) {
      const [resolver, , offset] = await client.readContract({
        address: universalResolver, abi: universalResolverAbi, functionName: 'findResolver', args: [dnsEncode(name)],
      });
      return offset === 0n && !!ours && resolver.toLowerCase() === ours;
    },
    async commit(name, records, onSigned) {
      if (!ours) throw new Error('ENS_RESOLVER_ADDRESS is required');
      const wallet = walletFor(env.ENS_WRITER_PRIVATE_KEY, 'ENS_WRITER_PRIVATE_KEY');
      const request = await wallet.prepareTransactionRequest({
        account: wallet.account!,
        chain: sepolia,
        to: ours as Address,
        data: encodeFunctionData({ abi: resolverAbi, functionName: 'multicall', args: [waveRecordCalls(name, records)] }),
      });
      const signed = await wallet.signTransaction(request);
      const hash = keccak256(signed);
      if (onSigned) await onSigned(hash);
      const sent = await client.sendRawTransaction({ serializedTransaction: signed });
      if (sent !== hash) throw new Error(`transaction hash ${sent} differs from the signed ${hash}`);
      return sent;
    },
    async receipt(tx) {
      try {
        const r = await client.getTransactionReceipt({ hash: tx });
        return r.status === 'success' ? 'success' : 'reverted';
      } catch (e) {
        if (!(e instanceof TransactionReceiptNotFoundError)) return 'pending'; // RPC trouble: ask again later
      }
      try {
        await client.getTransaction({ hash: tx });
        return 'pending'; // in the mempool
      } catch (e) {
        return e instanceof TransactionNotFoundError ? 'dropped' : 'pending';
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
