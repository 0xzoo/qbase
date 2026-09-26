// Read a question's records through the ENS Universal Resolver, with nothing from qbase in
// the path: no qbase API, no qbase database, no qbase code. Only viem and a Sepolia RPC.
// Deliberately self-contained (no local imports) so it can be copied out and run alone.
//
//   node read.ts <qid>.q.askqbase.eth [--rpc https://...]

import { parseArgs } from 'node:util'
import { createPublicClient, http, sha256, stringToBytes } from 'viem'
import { sepolia } from 'viem/chains'
import { normalize } from 'viem/ens'

const KEYS = ['qbase.question', 'qbase.canonical', 'qbase.waves'] as const

export async function readQuestion(name: string, rpc: string) {
  // viem ships the Sepolia Universal Resolver address; it is never hardcoded here.
  const client = createPublicClient({ chain: sepolia, transport: http(rpc) })
  const normalized = normalize(name)
  const resolver = await client.getEnsResolver({ name: normalized })
  const records = Object.fromEntries(
    await Promise.all(KEYS.map(async (key) => [key, await client.getEnsText({ name: normalized, key })] as const)),
  ) as Record<(typeof KEYS)[number], string | null>

  // The canonical record commits to the question text; check the two agree.
  let textMatchesCanonical: boolean | null = null
  if (records['qbase.question'] !== null && records['qbase.canonical'] !== null) {
    const canonical = JSON.parse(records['qbase.canonical']) as { id: string; sha256: string }
    textMatchesCanonical = canonical.sha256 === sha256(stringToBytes(records['qbase.question']))
  }
  return { name: normalized, universalResolver: sepolia.contracts.ensUniversalResolver.address, resolver, records, textMatchesCanonical }
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { rpc: { type: 'string', default: process.env.SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com' } },
  })
  if (positionals.length !== 1) {
    console.error('usage: node read.ts <qid>.q.askqbase.eth [--rpc URL]')
    process.exit(2)
  }
  const result = await readQuestion(positionals[0], values.rpc!)
  console.log(JSON.stringify(result, null, 2))
  if (result.records['qbase.question'] === null || result.textMatchesCanonical !== true) process.exit(1)
}
