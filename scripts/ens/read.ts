// Read a question's records through the ENS Universal Resolver, with nothing from qbase in
// the path: no qbase API, no qbase database, no qbase code. Only viem, a Sepolia RPC and,
// for each committed wave, an Arweave gateway to fetch the bundle the chain vouches for.
// Deliberately self-contained (no local imports) so it can be copied out and run alone.
//
//   node read.ts <qid>.q.askqbase.eth [--rpc https://...] [--gateway https://arweave.net]

import { parseArgs } from 'node:util'
import {
  createPublicClient,
  decodeAbiParameters,
  encodeFunctionData,
  http,
  namehash,
  parseAbi,
  sha256,
  stringToBytes,
  toHex,
  type Hex,
} from 'viem'
import { sepolia } from 'viem/chains'
import { normalize } from 'viem/ens'

const KEYS = ['qbase.question', 'qbase.canonical', 'qbase.waves'] as const

const universalResolverAbi = parseAbi(['function resolve(bytes name, bytes data) view returns (bytes, address)'])
const recordAbi = parseAbi([
  'function data(bytes32 node, string key) view returns (bytes)',
  'function contenthash(bytes32 node) view returns (bytes)',
])

function dnsEncode(name: string): Hex {
  const out: number[] = []
  for (const label of name.split('.').filter(Boolean)) {
    const bytes = stringToBytes(label)
    out.push(bytes.length, ...bytes)
  }
  out.push(0)
  return toHex(Uint8Array.from(out))
}

export async function readQuestion(name: string, rpc: string, gateway = 'https://turbo-gateway.com') {
  // viem ships the Sepolia Universal Resolver address; it is never hardcoded here.
  const client = createPublicClient({ chain: sepolia, transport: http(rpc) })
  const universalResolver = sepolia.contracts.ensUniversalResolver.address
  const normalized = normalize(name)
  const node = namehash(normalized)
  const resolver = await client.getEnsResolver({ name: normalized })
  const records = Object.fromEntries(
    await Promise.all(KEYS.map(async (key) => [key, await client.getEnsText({ name: normalized, key })] as const)),
  ) as Record<(typeof KEYS)[number], string | null>

  // ENSIP-24 data and ENSIP-7 contenthash have no viem helper; ask the Universal Resolver directly.
  async function resolveBytes(data: Hex): Promise<Hex | null> {
    try {
      const [raw] = await client.readContract({ address: universalResolver, abi: universalResolverAbi, functionName: 'resolve', args: [dnsEncode(normalized), data] })
      const [value] = decodeAbiParameters([{ type: 'bytes' }], raw)
      return value === '0x' ? null : value
    } catch {
      return null
    }
  }

  // The canonical record commits to the question text; check the two agree.
  let textMatchesCanonical: boolean | null = null
  if (records['qbase.question'] !== null && records['qbase.canonical'] !== null) {
    const canonical = JSON.parse(records['qbase.canonical']) as { id: string; sha256: string }
    textMatchesCanonical = canonical.sha256 === sha256(stringToBytes(records['qbase.question']))
  }

  // Each committed wave: its summary, its hash, and the bundle re-hashed from where the summary points.
  const waveIds = records['qbase.waves'] ? (JSON.parse(records['qbase.waves']) as string[]) : []
  const waves = await Promise.all(waveIds.map(async (id) => {
    const summaryText = await client.getEnsText({ name: normalized, key: `qbase.wave.${id}` })
    const summary = summaryText ? (JSON.parse(summaryText) as { bundle?: string; n?: number; tally_sha256?: string }) : null
    const onchainHash = await resolveBytes(encodeFunctionData({ abi: recordAbi, functionName: 'data', args: [node, `qbase.wave.${id}.hash`] }))
    let bundleUrl: string | null = null
    let bundleSha256: Hex | null = null
    if (summary?.bundle) {
      bundleUrl = summary.bundle.startsWith('ar://') ? `${gateway}/${summary.bundle.slice(5)}` : summary.bundle
      try {
        const res = await fetch(bundleUrl, { redirect: 'follow' })
        if (res.ok) bundleSha256 = sha256(new Uint8Array(await res.arrayBuffer()))
      } catch {
        // gateway unreachable: reported as a null hash
      }
    }
    return {
      id,
      summary,
      onchainHash,
      bundleUrl,
      bundleSha256,
      bundleMatchesChain: !!onchainHash && !!bundleSha256 && onchainHash.toLowerCase() === bundleSha256.toLowerCase(),
    }
  }))

  // contenthash: 0x90b2ca05 (the `arweave` multicodec) + the 32 bytes of the latest bundle's id.
  const contenthash = await resolveBytes(encodeFunctionData({ abi: recordAbi, functionName: 'contenthash', args: [node] }))
  const contenthashArweave = contenthash?.startsWith('0x90b2ca05')
    ? `ar://${Buffer.from(contenthash.slice(10), 'hex').toString('base64url')}`
    : null

  return { name: normalized, universalResolver, resolver, records, textMatchesCanonical, waves, contenthash: contenthashArweave ?? contenthash }
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      rpc: { type: 'string', default: process.env.SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com' },
      gateway: { type: 'string', default: process.env.ARWEAVE_GATEWAY ?? 'https://turbo-gateway.com' },
    },
  })
  if (positionals.length !== 1) {
    console.error('usage: node read.ts <qid>.q.askqbase.eth [--rpc URL] [--gateway URL]')
    process.exit(2)
  }
  const result = await readQuestion(positionals[0], values.rpc!, values.gateway!)
  console.log(JSON.stringify(result, null, 2))
  if (result.records['qbase.question'] === null || result.textMatchesCanonical !== true) process.exit(1)
  if (result.waves.some((w) => !w.bundleMatchesChain)) process.exit(1)
}
