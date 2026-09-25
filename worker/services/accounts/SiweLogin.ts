/**
 * Sign-In with Ethereum, with the ENS name as the display handle
 * (docs/specs/account-root.md §6.2).
 *
 * The credential is the ADDRESS, never the name: names lapse and change
 * hands, and an account bound to a name would pass to whoever registers it
 * next. The name is resolved on every login (reverse record, then a forward
 * check that the name resolves back to the address — a reverse record alone
 * is claimable by anyone) and stored as the credential's label.
 */

import { createPublicClient, http, recoverMessageAddress, type Hex } from 'viem';
import { mainnet } from 'viem/chains';
import { normalize } from 'viem/ens';
import { generateSiweNonce, parseSiweMessage, validateSiweMessage, verifySiweMessage } from 'viem/siwe';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

const NONCE_TTL_S = 300;
const nonceKey = (n: string) => `siwe_nonce:${n}`;

export class SiweError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

export interface SiweDeps {
  /** Smart-wallet signature check (ERC-1271 / 6492) through an RPC. */
  verifyViaRpc(env: Env, message: string, signature: Hex, domain: string, nonce: string): Promise<boolean>;
  /** Verified primary ENS name for an address, or null. */
  resolveEnsName(env: Env, address: `0x${string}`): Promise<string | null>;
}

function mainnetClient(env: Env) {
  const url = typeof env?.ETH_MAINNET_RPC_URL === 'string' && env.ETH_MAINNET_RPC_URL ? env.ETH_MAINNET_RPC_URL : 'https://ethereum-rpc.publicnode.com';
  return createPublicClient({ chain: mainnet, transport: http(url, { timeout: 5_000 }) });
}

const defaultDeps: SiweDeps = {
  async verifyViaRpc(env, message, signature, domain, nonce) {
    return verifySiweMessage(mainnetClient(env), { message, signature, domain, nonce });
  },
  async resolveEnsName(env, address) {
    try {
      const client = mainnetClient(env);
      const name = await client.getEnsName({ address });
      if (!name) return null;
      const back = await client.getEnsAddress({ name: normalize(name) });
      return back && back.toLowerCase() === address.toLowerCase() ? name : null;
    } catch (e) {
      console.warn('[SIWE] ENS resolution failed:', e);
      return null;
    }
  },
};
let deps: SiweDeps = defaultDeps;

/** Tests only. */
export function setSiweDepsForTests(d: Partial<SiweDeps> | null): void {
  deps = d ? { ...defaultDeps, ...d } : defaultDeps;
}

/** The domain a SIWE message must name: the configured host (the request host on *.workers.dev previews). */
export function expectedDomain(env: Env, requestUrl: string): string {
  const url = new URL(requestUrl);
  if (url.hostname.includes('.workers.dev') || url.hostname === 'localhost' || url.hostname === '127.0.0.1') return url.host;
  return env.HOSTNAME || url.host;
}

export async function issueNonce(env: Env): Promise<string> {
  const nonce = generateSiweNonce();
  await env.KV_USER_PROFILES.put(nonceKey(nonce), '1', { expirationTtl: NONCE_TTL_S });
  return nonce;
}

/**
 * Verify a SIWE message + signature. Returns the lowercase address and its
 * verified ENS name. The nonce is single-use and consumed before the
 * signature is checked.
 */
export async function verifySiwe(env: Env, requestUrl: string, message: string, signature: Hex): Promise<{ address: `0x${string}`; ensName: string | null }> {
  if (typeof message !== 'string' || typeof signature !== 'string' || !/^0x[0-9a-fA-F]+$/.test(signature)) throw new SiweError('invalid_request');
  const parsed = parseSiweMessage(message);
  if (!parsed.address || !parsed.nonce || !parsed.domain) throw new SiweError('invalid_message');
  const domain = expectedDomain(env, requestUrl);
  if (!validateSiweMessage({ message: parsed, domain, nonce: parsed.nonce, time: new Date() })) throw new SiweError('invalid_message');
  if (parsed.chainId !== undefined && parsed.chainId !== 1) throw new SiweError('wrong_chain');

  const key = nonceKey(parsed.nonce);
  if (!(await env.KV_USER_PROFILES.get(key))) throw new SiweError('nonce_expired');
  await env.KV_USER_PROFILES.delete(key);

  const address = parsed.address.toLowerCase() as `0x${string}`;
  let ok = false;
  try {
    const recovered = await recoverMessageAddress({ message, signature });
    ok = recovered.toLowerCase() === address;
  } catch {
    ok = false;
  }
  if (!ok) ok = await deps.verifyViaRpc(env, message, signature, domain, parsed.nonce).catch(() => false);
  if (!ok) throw new SiweError('bad_signature');

  return { address, ensName: await deps.resolveEnsName(env, address) };
}
