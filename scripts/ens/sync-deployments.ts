// Refresh deployments.sepolia.json from ensdomains/contracts-v2 and check it twice before
// setup trusts it: every ABI fragment in abi.ts must match the published ABI, and the set
// must be the one the canonical Universal Resolver (the proxy viem ships) actually walks.
// Sepolia has carried several ENSv2 sets; names registered in a stale one never resolve.
//
//   node sync-deployments.ts [--ref post-audit-2] [--rpc https://...]

import { writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { createPublicClient, getAddress, http, type Abi, type AbiFunction, type AbiParameter, type Address } from 'viem'
import { sepolia } from 'viem/chains'
import { CHECKED, registryAbi, universalResolverAbi, type ContractName } from './abi.ts'

const REPO = 'ensdomains/contracts-v2'
const DIR = 'contracts/deployments/sepolia'
const EIP1967_IMPL = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'

// As of 2026-09-26 the live set is on `post-audit-2`; `main` still carries the June set.
const { values } = parseArgs({
  options: {
    ref: { type: 'string', default: 'post-audit-2' },
    rpc: { type: 'string', default: process.env.SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com' },
  },
})

const commit = await fetch(`https://api.github.com/repos/${REPO}/commits/${encodeURIComponent(values.ref!)}`, {
  headers: { accept: 'application/vnd.github.sha' },
}).then((r) => {
  if (!r.ok) throw new Error(`resolve ${values.ref}: HTTP ${r.status}`)
  return r.text()
})

const contracts = {} as Record<ContractName, Address>
const problems: string[] = []

for (const name of Object.keys(CHECKED) as ContractName[]) {
  const url = `https://raw.githubusercontent.com/${REPO}/${commit}/${DIR}/${name}.json`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status} from ${url}`)
  const artifact = (await res.json()) as { address: string; abi: Abi }
  contracts[name] = getAddress(artifact.address)

  const published = new Set(artifact.abi.filter(isFunction).map(signature))
  for (const fragment of (CHECKED[name] as Abi).filter(isFunction)) {
    const sig = signature(fragment)
    if (!published.has(sig)) problems.push(`${name}: ${sig} not in the published ABI`)
  }
}

// Walk from viem's canonical proxy to the implementation behind it, then down to .eth.
const client = createPublicClient({ chain: sepolia, transport: http(values.rpc) })
const slot = (address: Address) =>
  client.getStorageAt({ address, slot: EIP1967_IMPL }).then((v) => getAddress(`0x${v!.slice(-40)}`))
const canonicalProxy = sepolia.contracts.ensUniversalResolver.address
let impl = await slot(canonicalProxy)
if (!same(impl, contracts.UniversalResolverV2)) impl = await slot(impl) // proxy -> managed proxy -> UR
const root = await client.readContract({ address: impl, abi: universalResolverAbi, functionName: 'ROOT_REGISTRY' })
const eth = await client.readContract({ address: root, abi: registryAbi, functionName: 'getSubregistry', args: ['eth'] })
for (const [label, live, synced] of [
  ['UniversalResolverV2', impl, contracts.UniversalResolverV2],
  ['RootRegistry', root, contracts.RootRegistry],
  ['ETHRegistry', eth, contracts.ETHRegistry],
] as const) {
  if (!same(live, synced)) problems.push(`${label}: canonical Universal Resolver uses ${live}, ${values.ref} says ${synced}`)
}

if (problems.length) {
  console.error(problems.join('\n'))
  console.error(`\n${REPO}@${values.ref} (${commit.slice(0, 7)}) is not usable: fix abi.ts, or pass the --ref whose deployments/sepolia matches the chain.`)
  process.exit(1)
}

const out = {
  source: `https://github.com/${REPO}/tree/${commit}/${DIR}`,
  ref: values.ref,
  commit,
  syncedAt: new Date().toISOString(),
  chainId: sepolia.id,
  canonicalUniversalResolver: canonicalProxy,
  contracts,
}
writeFileSync(new URL('./deployments.sepolia.json', import.meta.url), JSON.stringify(out, null, 2) + '\n')
console.log(`deployments.sepolia.json <- ${REPO}@${values.ref} (${commit.slice(0, 7)})`)
console.log(`  fragments match; set is the one ${canonicalProxy} resolves through`)
for (const [name, address] of Object.entries(contracts)) console.log(`  ${name.padEnd(25)} ${address}`)

function same(a: string, b: string) {
  return a.toLowerCase() === b.toLowerCase()
}

function isFunction(item: Abi[number]): item is AbiFunction {
  return item.type === 'function'
}

// name(inputs)->(outputs), tuples expanded, so a changed return shape is caught too.
function signature(fn: AbiFunction): string {
  return `${fn.name}(${fn.inputs.map(type).join(',')})->(${fn.outputs.map(type).join(',')})`
}

function type(p: AbiParameter): string {
  if (!p.type.startsWith('tuple')) return p.type
  const components = 'components' in p ? p.components : []
  return `(${components.map(type).join(',')})${p.type.slice('tuple'.length)}`
}
