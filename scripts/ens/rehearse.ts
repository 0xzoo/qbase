// Rehearse setup.ts against an anvil fork of Sepolia: no keys, no ETH, nothing broadcast.
// Uses anvil's funded dev accounts, warps time for the commitment, then checks the writer's
// role boundary and that a second run is a no-op.
//
//   node rehearse.ts [--question <qid>] [--fork-url https://...]

import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import { createPublicClient, createTestClient, createWalletClient, http, keccak256, parseEther, stringToBytes, type Abi, type Address, type LocalAccount } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { sepolia } from 'viem/chains'
import { resolverAbi } from './abi.ts'
import { ALL_ROLES, dnsEncode } from './lib.ts'
import { readQuestion } from './read.ts'
import { setup } from './setup.ts'

// Fresh throwaway keys, funded on the fork. Not anvil's default dev keys: on Sepolia those
// are public and carry EIP-7702 sweeper code, which rejects the ERC-1155 name token.
const DEPLOYER = privateKeyToAccount(generatePrivateKey())
const WRITER = privateKeyToAccount(generatePrivateKey())
const STRANGER = privateKeyToAccount(generatePrivateKey())

const { values } = parseArgs({
  options: {
    question: { type: 'string' },
    'fork-url': { type: 'string', default: process.env.SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com' },
    'qbase-api': { type: 'string', default: process.env.QBASE_API ?? 'https://qbase.tech' },
    port: { type: 'string', default: '8546' },
  },
})
const rpc = `http://127.0.0.1:${values.port}`
const api = values['qbase-api']!

const questionId = values.question ?? (await latestQuestionId(api))

console.log(`anvil --fork-url ${values['fork-url']} --port ${values.port}`)
const anvil = spawn('anvil', ['--fork-url', values['fork-url']!, '--port', values.port!], { stdio: ['ignore', 'pipe', 'pipe'] })
let anvilOutput = ''
anvil.stdout.on('data', (d) => (anvilOutput += d))
anvil.stderr.on('data', (d) => (anvilOutput += d))
const stop = () => anvil.kill('SIGTERM')
process.on('exit', stop)

let failed = false
try {
  const pub = createPublicClient({ chain: sepolia, transport: http(rpc) })
  await waitForRpc(pub)
  console.log(`fork at Sepolia block ${await pub.getBlockNumber()}\n`)

  const test = createTestClient({ chain: sepolia, mode: 'anvil', transport: http(rpc) })
  const warp = async (seconds: number) => {
    await test.increaseTime({ seconds })
    await test.mine({ blocks: 1 })
  }
  for (const account of [DEPLOYER, WRITER, STRANGER]) await test.setBalance({ address: account.address, value: parseEther('10') })
  const base = {
    rpc,
    account: DEPLOYER,
    writer: WRITER.address,
    questionId,
    qbaseApi: api,
    label: 'askqbase',
    years: 1,
    warp,
  }

  const first = await setup({ ...base, outFile: new URL('./out/rehearsal.json', import.meta.url).pathname })

  console.log('\nwriter boundary')
  const name = dnsEncode(first.questionName)
  const hash = keccak256(stringToBytes('rehearsal bundle'))
  const expect = async (label: string, account: LocalAccount, functionName: string, args: readonly unknown[], allowed: boolean) => {
    const ok = await call(pub, first.resolver, account, functionName, args)
    const pass = ok === allowed
    if (!pass) failed = true
    console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${label}: ${ok ? 'allowed' : 'reverted'}`)
  }
  await expect('writer setText qbase.waves', WRITER, 'setText', [name, 'qbase.waves', '[]'], true)
  await expect('writer setData qbase.wave.<id>.hash', WRITER, 'setData', [name, 'qbase.wave.rehearsal.hash', hash], true)
  await expect('writer setAddress', WRITER, 'setAddress', [name, 60n, WRITER.address], false)
  await expect('writer grantRootRoles to itself', WRITER, 'grantRootRoles', [ALL_ROLES, WRITER.address], false)
  await expect('stranger setText', STRANGER, 'setText', [name, 'qbase.question', 'forged'], false)

  const read = await readQuestion(first.questionName, rpc)
  const readOk = read.records['qbase.waves'] === '[]' && read.textMatchesCanonical === true
  if (!readOk) failed = true
  console.log(`  ${readOk ? 'ok  ' : 'FAIL'} writer's record visible through the Universal Resolver`)

  console.log('\nsecond run (must send nothing)')
  const second = await setup({ ...base, outFile: new URL('./out/rehearsal-rerun.json', import.meta.url).pathname })
  const idempotent = second.txs.length === 0
  if (!idempotent) failed = true
  console.log(`  ${idempotent ? 'ok  ' : 'FAIL'} idempotent (${second.txs.length} transactions)`)

  console.log(`\nstandalone read: node read.ts ${first.questionName} --rpc ${values['fork-url']}   (after the real run)`)
} catch (err) {
  failed = true
  console.error(err)
  if (anvilOutput) console.error(`\nanvil output (tail):\n${anvilOutput.slice(-2000)}`)
} finally {
  stop()
}
console.log(failed ? '\nREHEARSAL FAILED' : '\nrehearsal passed')
process.exit(failed ? 1 : 0)

async function call(pub: ReturnType<typeof createPublicClient>, address: Address, account: LocalAccount, functionName: string, args: readonly unknown[]) {
  try {
    const { request } = await pub.simulateContract({ address, abi: resolverAbi as Abi, functionName, args, account } as never)
    const wallet = createWalletClient({ chain: sepolia, transport: http(rpc), account })
    const hash = await wallet.writeContract(request as never)
    return (await pub.waitForTransactionReceipt({ hash })).status === 'success'
  } catch {
    return false
  }
}

async function waitForRpc(pub: ReturnType<typeof createPublicClient>) {
  for (let i = 0; i < 60; i++) {
    if (anvil.exitCode !== null) throw new Error(`anvil exited (${anvil.exitCode})`)
    try {
      await pub.getChainId()
      return
    } catch {
      await sleep(500)
    }
  }
  throw new Error('anvil did not come up in 30 s')
}

async function latestQuestionId(apiBase: string): Promise<string> {
  const res = await fetch(`${apiBase.replace(/\/$/, '')}/api/queries?limit=1`)
  if (!res.ok) throw new Error(`list questions: HTTP ${res.status} from ${apiBase}`)
  const { results } = (await res.json()) as { results: { id: string }[] }
  if (!results?.length) throw new Error(`no questions at ${apiBase}`)
  return results[0].id
}
