import { readFileSync } from 'node:fs'
import {
  concat,
  encodeAbiParameters,
  getContractAddress,
  keccak256,
  namehash,
  stringToBytes,
  stringToHex,
  toHex,
  type Address,
  type Hex,
} from 'viem'
import type { ContractName } from './abi.ts'

// Role bits, from RegistryRolesLib.sol and PermissionedResolverLib.sol (contracts-v2 post-audit-2). Each role is one
// nybble; its admin counterpart sits 128 bits higher. Admin implies the role.
const admin = (role: bigint) => role << 128n

export const REGISTRY = {
  REGISTRAR: 1n << 0n,
  SET_PARENT: 1n << 8n,
  UNREGISTER: 1n << 12n,
  RENEW: 1n << 16n,
  SET_SUBREGISTRY: 1n << 20n,
  SET_RESOLVER: 1n << 24n,
  CAN_TRANSFER_ADMIN: admin(1n << 28n),
  UPGRADE: 1n << 124n,
}

export const RESOLVER = {
  SET_ADDRESS: 1n << 0n,
  SET_TEXT: 1n << 4n,
  SET_CONTENTHASH: 1n << 8n,
  SET_DATA: 1n << 24n,
  LINK: 1n << 28n,
  UPGRADE: 1n << 124n,
}

export const ALL_ROLES = 0x1111111111111111111111111111111111111111111111111111111111111111n
export const MAX_EXPIRY = (1n << 64n) - 1n

export const STATUS = { AVAILABLE: 0, RESERVED: 1, REGISTERED: 2 } as const

// `q.askqbase.eth`: qbase can relink its subregistry or give it a resolver, and holds the
// admin bits so it can revoke both later (plan §7.7). No transfer role.
export const Q_NAME_ROLES =
  REGISTRY.SET_SUBREGISTRY | admin(REGISTRY.SET_SUBREGISTRY) |
  REGISTRY.SET_RESOLVER | admin(REGISTRY.SET_RESOLVER)

// A question name: no transfer, no subregistry, no renew (expiry is already max). The
// resolver can be changed until the admin bit is revoked in the post-event freeze.
export const QUESTION_ROLES = REGISTRY.SET_RESOLVER | admin(REGISTRY.SET_RESOLVER)

// The writer key: record setters on the shared resolver, no admin bits, so it cannot grant,
// link or upgrade. Post-audit roles are scoped per record key or root, never per name, so its
// reach is every text, data and contenthash record on every name this resolver serves.
// The namer key: may register *available* labels in UserRegistry(q.askqbase.eth) and nothing
// else. PermissionedRegistry._register reverts on a registered label, so it cannot touch an
// existing question name, and it holds no role on askqbase.eth, its registry or the resolver.
export const NAMER_ROLES = REGISTRY.REGISTRAR

export const WRITER_ROLES = RESOLVER.SET_TEXT | RESOLVER.SET_DATA | RESOLVER.SET_CONTENTHASH

export type Deployments = { commit: string; chainId: number; contracts: Record<ContractName, Address> }

export function loadDeployments(): Deployments {
  return JSON.parse(readFileSync(new URL('./deployments.sepolia.json', import.meta.url), 'utf8'))
}

// Salt conventions from contracts-v2 script/setup.ts, so our proxies sit where ENS's own
// tooling would expect them.
export function ownedResolverSalt(owner: Address, version = 0n): bigint {
  return BigInt(
    keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'address' }, { type: 'uint256' }],
        [keccak256(stringToHex('OwnedResolver')), owner, version],
      ),
    ),
  )
}

export function userRegistrySalt(name: string, version = 0n): bigint {
  return BigInt(
    keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }],
        [keccak256(stringToHex('UserRegistry')), namehash(name), version],
      ),
    ),
  )
}

// VerifiableFactory's CREATE2 address. The deployed factory predates `predictProxyAddress`,
// so this mirrors contracts-v2 test/integration/fixtures/deployVerifiableProxy.ts.
export function predictProxy(factory: Address, proxyLogic: Address, deployer: Address, salt: bigint): Address {
  const outerSalt = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [deployer, salt]))
  const bytecode = concat([
    '0x3d604d80600a3d3981f3363d3d373d3d3d363d73',
    proxyLogic,
    '0x5af43d82803e903d91602b57fd5bf3',
    outerSalt,
  ])
  return getContractAddress({ bytecode, from: factory, opcode: 'CREATE2', salt: outerSalt })
}

export function labelId(label: string): bigint {
  return BigInt(keccak256(stringToBytes(label)))
}

export function dnsEncode(name: string): Hex {
  const parts: Uint8Array[] = []
  for (const label of name.split('.').filter(Boolean)) {
    const bytes = stringToBytes(label)
    if (bytes.length > 255) throw new Error(`label too long: ${label}`)
    parts.push(Uint8Array.of(bytes.length), bytes)
  }
  parts.push(Uint8Array.of(0))
  return toHex(concat(parts))
}

export const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
