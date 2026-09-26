// Give the worker's namer key ROLE_REGISTRAR on UserRegistry(q.askqbase.eth), so a question
// is named when its first wave opens instead of waiting for someone to run setup.ts. The
// namer can register available labels there and nothing else: _register reverts on a
// registered label, and it holds no role on askqbase.eth, its registry or the resolver.
// Idempotent. Revoke with revokeRootRoles(ROLE_REGISTRAR, namer) from the deployer.
//
//   DEPLOYER_PRIVATE_KEY=0x... NAMER_ADDRESS=0x... node grant-namer.ts [--rpc URL] [--fund 0.01]

import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { createPublicClient, createWalletClient, http, parseEther, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { sepolia } from 'viem/chains'
import { registryAbi } from './abi.ts'
import { NAMER_ROLES } from './lib.ts'

export async function grantNamer(opts: { rpc: string; deployerKey: Hex; namer: Address; fundEth?: string; out?: string }) {
  const out = JSON.parse(readFileSync(opts.out ?? new URL('./out/sepolia.json', import.meta.url).pathname, 'utf8'))
  const qRegistry = out.contracts['userRegistry(q.askqbase.eth)'] as Address
  const account = privateKeyToAccount(opts.deployerKey)
  const client = createPublicClient({ chain: sepolia, transport: http(opts.rpc) })
  const wallet = createWalletClient({ chain: sepolia, transport: http(opts.rpc), account })
  const done: string[] = []

  if (await client.readContract({ address: qRegistry, abi: registryAbi, functionName: 'hasRootRoles', args: [NAMER_ROLES, opts.namer] })) {
    done.push('namer already holds ROLE_REGISTRAR')
  } else {
    const hash = await wallet.writeContract({ address: qRegistry, abi: registryAbi, functionName: 'grantRootRoles', args: [NAMER_ROLES, opts.namer] })
    const r = await client.waitForTransactionReceipt({ hash })
    if (r.status !== 'success') throw new Error(`grantRootRoles reverted: ${hash}`)
    done.push(`granted ROLE_REGISTRAR on ${qRegistry}: ${hash}`)
  }
  if (opts.fundEth && (await client.getBalance({ address: opts.namer })) < parseEther(opts.fundEth) / 2n) {
    const hash = await wallet.sendTransaction({ to: opts.namer, value: parseEther(opts.fundEth) })
    await client.waitForTransactionReceipt({ hash })
    done.push(`funded namer with ${opts.fundEth} ETH: ${hash}`)
  }
  return { qRegistry, namer: opts.namer, done }
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      rpc: { type: 'string', default: process.env.SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com' },
      fund: { type: 'string' },
    },
  })
  const deployerKey = process.env.DEPLOYER_PRIVATE_KEY as Hex | undefined
  const namer = process.env.NAMER_ADDRESS as Address | undefined
  if (!deployerKey || !namer) {
    console.error('DEPLOYER_PRIVATE_KEY and NAMER_ADDRESS are required')
    process.exit(2)
  }
  console.log(JSON.stringify(await grantNamer({ rpc: values.rpc!, deployerKey, namer, fundEth: values.fund }), null, 2))
}
