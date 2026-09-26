// The subset of the ENSv2 contract interfaces these scripts call, as human-readable
// fragments. `sync-deployments.ts` checks every fragment against the ABI ENS publishes
// with its Sepolia deployment, so a changed interface fails the sync, not a transaction.

import { parseAbi } from 'viem'

export const ethRegistrarAbi = parseAbi([
  'function isAvailable(string label) view returns (bool)',
  'function MIN_COMMITMENT_AGE() view returns (uint64)',
  'function MAX_COMMITMENT_AGE() view returns (uint64)',
  'function commitmentAt(bytes32 commitment) view returns (uint64)',
  'function makeCommitment(string label, address owner, bytes32 secret, address subregistry, address resolver, uint64 duration, bytes32 referrer) pure returns (bytes32)',
  'function getRegisterPrice(string label, uint64 duration, address paymentToken) view returns (uint256 base, uint256 premium)',
  'function commit(bytes32 commitment)',
  'function register(string label, address owner, bytes32 secret, address subregistry, address resolver, uint64 duration, address paymentToken, bytes32 referrer) returns (uint256)',
])

// ETHRegistry and every UserRegistry proxy share the PermissionedRegistry interface.
export const registryAbi = parseAbi([
  'struct State { uint8 status; uint64 expiry; address latestOwner; uint256 tokenId; uint256 resource; }',
  'function getState(uint256 anyId) view returns (State state)',
  'function getSubregistry(string label) view returns (address)',
  'function getResolver(string label) view returns (address)',
  'function getParent() view returns (address, string)',
  'function hasRootRoles(uint256 roleBitmap, address account) view returns (bool)',
  'function setParent(address parent, string label)',
  'function setSubregistry(uint256 anyId, address registry)',
  'function setResolver(uint256 anyId, address resolver)',
  'function register(string label, address owner, address registry, address resolver, uint256 roleBitmap, uint64 expiry) returns (uint256)',
])

export const userRegistryAbi = parseAbi([
  'struct Grant { address account; uint256 roleBitmap; }',
  'function initialize(Grant[] grants)',
])

// Post-audit PermissionedResolver: setters take the DNS-encoded name, permissions are scoped
// per record key or root (never per name), and reads go through `resolve(name, data)`.
export const resolverAbi = parseAbi([
  'struct Grant { address account; uint256 roleBitmap; }',
  'function initialize(Grant[] grants, bytes[] calls)',
  'function grantRootRoles(uint256 roleBitmap, address account) returns (bool)',
  'function hasRootRoles(uint256 roleBitmap, address account) view returns (bool)',
  'function setText(bytes name, string key, string value)',
  'function setData(bytes name, string key, bytes value)',
  'function setAddress(bytes name, uint256 coinType, bytes addressBytes)',
  'function multicall(bytes[] calls) returns (bytes[])',
  'function resolve(bytes name, bytes data) view returns (bytes)',
  'function getRecordId(bytes32 node) view returns (uint256)',
])

// ENSIP-5 text(), encoded as the `data` argument of resolve().
export const textResolverAbi = parseAbi(['function text(bytes32 node, string key) view returns (string)'])

export const factoryAbi = parseAbi([
  'function deployProxy(address implementation, uint256 salt, bytes data) returns (address)',
  'function proxyLogic() view returns (address)',
  'function verifyContract(address proxy) view returns (address)',
  'event ProxyDeployed(address indexed sender, address indexed proxyAddress, uint256 salt, address implementation)',
])

export const mockUsdcAbi = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function mint(address to, uint256 amount)',
  'function approve(address spender, uint256 value) returns (bool)',
])

export const universalResolverAbi = parseAbi([
  'function ROOT_REGISTRY() view returns (address)',
  'function findResolver(bytes name) view returns (address resolver, bytes32 node, uint256 offset)',
])

// Deployment artifact name -> fragments that must match its published ABI.
export const CHECKED = {
  ETHRegistrar: ethRegistrarAbi,
  ETHRegistry: registryAbi,
  UserRegistryImpl: [...registryAbi, ...userRegistryAbi],
  PermissionedResolverImpl: resolverAbi,
  VerifiableFactory: factoryAbi,
  MockUSDC: mockUsdcAbi,
  UniversalResolverV2: universalResolverAbi,
  RootRegistry: registryAbi,
} as const

export type ContractName = keyof typeof CHECKED
