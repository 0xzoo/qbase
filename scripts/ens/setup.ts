// ENSv2 setup for askqbase.eth on Sepolia (plan §7.6). Idempotent: every step reads chain
// state first and skips what is already done, so a run that dies halfway is resumed by
// running it again.
//
//   1. deploy qbase's PermissionedResolver             (VerifiableFactory proxy)
//   2. deploy UserRegistry(askqbase.eth), UserRegistry(q.askqbase.eth)
//   3. register askqbase.eth on the ETH Registrar       (MockUSDC, commit, 60 s, register)
//      with subregistry + resolver set in the registration itself
//   4. mount q.askqbase.eth, setParent on both registries
//   5. grantRootRoles(SET_TEXT | SET_DATA | SET_CONTENTHASH) to the writer
//   6. register <qid>.q.askqbase.eth with max expiry, write its records
//   7. read everything back through the Universal Resolver
//
//   DEPLOYER_PRIVATE_KEY=0x... WRITER_ADDRESS=0x... node setup.ts --question <qid>
//
// Rehearse first with `node rehearse.ts`, which runs this against an anvil fork of Sepolia.

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import {
  createPublicClient,
  createWalletClient,
  decodeFunctionResult,
  encodeFunctionData,
  formatEther,
  getAddress,
  http,
  keccak256,
  namehash,
  parseEventLogs,
  sha256,
  stringToBytes,
  zeroAddress,
  zeroHash,
  type Abi,
  type Address,
  type Hex,
  type LocalAccount,
  type TransactionReceipt,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { sepolia } from 'viem/chains'
import { normalize } from 'viem/ens'
import {
  ethRegistrarAbi,
  factoryAbi,
  mockUsdcAbi,
  registryAbi,
  resolverAbi,
  textResolverAbi,
  universalResolverAbi,
  userRegistryAbi,
} from './abi.ts'
import {
  ALL_ROLES,
  MAX_EXPIRY,
  QUESTION_ROLES,
  Q_NAME_ROLES,
  STATUS,
  WRITER_ROLES,
  dnsEncode,
  labelId,
  loadDeployments,
  ownedResolverSalt,
  predictProxy,
  same,
  userRegistrySalt,
} from './lib.ts'
import { readQuestion } from './read.ts'

export type SetupOptions = {
  rpc: string
  account: LocalAccount
  writer: Address
  questionId: string
  qbaseApi: string
  label: string
  years: number
  outFile: string
  /** anvil only: advance chain time instead of waiting for the commitment to age */
  warp?: (seconds: number) => Promise<void>
}

type Tx = { step: string; hash: Hex; gasUsed: bigint; fee: bigint }

// Public, well-known keys (anvil/hardhat accounts 0 and 1): never on a live network.
const DEV_ADDRESSES = ['0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', '0x70997970C51812dc3A010C7d01b50e0d17dc79C8']

export async function setup(opts: SetupOptions) {
  const { account } = opts
  const { contracts, commit: ensCommit } = loadDeployments()
  const pub = createPublicClient({ chain: sepolia, transport: http(opts.rpc) })
  const wallet = createWalletClient({ chain: sepolia, transport: http(opts.rpc), account })
  const txs: Tx[] = []

  const parentName = `${opts.label}.eth`
  const qName = `q.${parentName}`

  // --- preflight -----------------------------------------------------------------------
  const chainId = await pub.getChainId()
  if (chainId !== sepolia.id) throw new Error(`RPC is chain ${chainId}, expected Sepolia (${sepolia.id})`)
  if (DEV_ADDRESSES.some((a) => same(a, account.address))) {
    throw new Error('refusing a public anvil dev key (on Sepolia it is shared and carries EIP-7702 sweeper code)')
  }
  // The deployer receives the ERC-1155 name tokens; an account with code must accept them.
  const deployerCode = await pub.getCode({ address: account.address })
  if (deployerCode && deployerCode !== '0x') {
    throw new Error(`deployer ${account.address} has code (${deployerCode.slice(0, 10)}…, EIP-7702?); use a plain EOA`)
  }
  for (const [name, address] of Object.entries(contracts)) {
    const code = await pub.getCode({ address })
    if (!code || code === '0x') throw new Error(`${name} has no code at ${address} (deployments.sepolia.json stale? run sync)`)
  }

  const question = await fetchQuestion(opts.qbaseApi, opts.questionId)
  const questionName = normalize(`${question.id.toLowerCase()}.${qName}`)
  if (questionName !== `${question.id.toLowerCase()}.${qName}`) throw new Error(`question id ${question.id} is not a normalized ENS label`)
  const questionLabel = question.id.toLowerCase()

  const balance = await pub.getBalance({ address: account.address })
  log(`ENSv2 setup  ${parentName}  (contracts-v2@${ensCommit.slice(0, 7)})`)
  log(`  deployer   ${account.address}  ${formatEther(balance)} ETH`)
  log(`  writer     ${opts.writer}`)
  log(`  question   ${question.id}  "${truncate(question.stem, 60)}"`)

  const read = (address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) =>
    pub.readContract({ address, abi, functionName, args } as never) as Promise<any>

  async function send(step: string, address: Address, abi: Abi, functionName: string, args: readonly unknown[]): Promise<TransactionReceipt> {
    const { request } = await pub.simulateContract({ address, abi, functionName, args, account } as never)
    const hash = await wallet.writeContract(request as never)
    const receipt = await pub.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') throw new Error(`${step} reverted: ${hash}`)
    const fee = receipt.gasUsed * receipt.effectiveGasPrice
    txs.push({ step, hash, gasUsed: receipt.gasUsed, fee })
    log(`  + ${step.padEnd(44)} gas ${String(receipt.gasUsed).padStart(8)}  ${hash}`)
    return receipt
  }
  const skip = (step: string, why = 'already done') => log(`  = ${step.padEnd(44)} ${why}`)

  // --- 1, 2: proxies through the Verifiable Factory ---------------------------------------
  const proxyLogic: Address = await read(contracts.VerifiableFactory, factoryAbi, 'proxyLogic')
  // The deployer is root on all three: every role and every admin bit (plan §7.7 revokes later).
  const admin = { account: account.address, roleBitmap: ALL_ROLES }

  async function ensureProxy(step: string, impl: Address, salt: bigint, initData: Hex): Promise<Address> {
    const predicted = predictProxy(contracts.VerifiableFactory, proxyLogic, account.address, salt)
    const code = await pub.getCode({ address: predicted })
    if (code && code !== '0x') skip(step, `at ${predicted}`)
    else {
      const receipt = await send(step, contracts.VerifiableFactory, factoryAbi, 'deployProxy', [impl, salt, initData])
      const [event] = parseEventLogs({ abi: factoryAbi, eventName: 'ProxyDeployed', logs: receipt.logs })
      // Reruns find the proxy by prediction, so the prediction must be exact.
      if (!event || !same(event.args.proxyAddress, predicted)) {
        throw new Error(`${step}: deployed at ${event?.args.proxyAddress}, predicted ${predicted} (factory bytecode changed?)`)
      }
    }
    const actualImpl: Address = await read(contracts.VerifiableFactory, factoryAbi, 'verifyContract', [predicted])
    if (!same(actualImpl, impl)) throw new Error(`${step}: proxy ${predicted} points at ${actualImpl}, expected ${impl}`)
    return predicted
  }

  const resolver = await ensureProxy(
    'deploy PermissionedResolver',
    contracts.PermissionedResolverImpl,
    ownedResolverSalt(account.address),
    encodeFunctionData({ abi: resolverAbi, functionName: 'initialize', args: [[admin], []] }),
  )
  const parentRegistry = await ensureProxy(
    `deploy UserRegistry(${parentName})`,
    contracts.UserRegistryImpl,
    userRegistrySalt(parentName),
    encodeFunctionData({ abi: userRegistryAbi, functionName: 'initialize', args: [[admin]] }),
  )
  const qRegistry = await ensureProxy(
    `deploy UserRegistry(${qName})`,
    contracts.UserRegistryImpl,
    userRegistrySalt(qName),
    encodeFunctionData({ abi: userRegistryAbi, functionName: 'initialize', args: [[admin]] }),
  )

  // --- 3: askqbase.eth on the ETH Registrar ------------------------------------------------
  const ethState = await read(contracts.ETHRegistry, registryAbi, 'getState', [labelId(opts.label)])
  if (ethState.status === STATUS.REGISTERED) {
    if (!same(ethState.latestOwner, account.address)) throw new Error(`${parentName} is registered to ${ethState.latestOwner}`)
    skip(`register ${parentName}`, `expires ${new Date(Number(ethState.expiry) * 1000).toISOString()}`)
    // A rerun after a partial setup: point the name at our registry and resolver.
    if (!same(await read(contracts.ETHRegistry, registryAbi, 'getSubregistry', [opts.label]), parentRegistry)) {
      await send(`setSubregistry ${parentName}`, contracts.ETHRegistry, registryAbi, 'setSubregistry', [ethState.tokenId, parentRegistry])
    }
    if (!same(await read(contracts.ETHRegistry, registryAbi, 'getResolver', [opts.label]), resolver)) {
      await send(`setResolver ${parentName}`, contracts.ETHRegistry, registryAbi, 'setResolver', [ethState.tokenId, resolver])
    }
  } else {
    if (!(await read(contracts.ETHRegistrar, ethRegistrarAbi, 'isAvailable', [opts.label]))) {
      throw new Error(`${parentName} is not available on the ENSv2 ETH Registrar`)
    }
    const duration = BigInt(Math.round(opts.years * 365 * 86400))
    // Derived from the deployer's key, so a rerun finds its own commitment without storing
    // a secret, and nobody else can compute it.
    const secret = keccak256(await account.signMessage({ message: `qbase ENSv2 commitment secret for ${parentName}` }))
    const registerArgs = [opts.label, account.address, secret, parentRegistry, resolver, duration] as const
    const commitment: Hex = await read(contracts.ETHRegistrar, ethRegistrarAbi, 'makeCommitment', [...registerArgs, zeroHash])

    const [minAge, maxAge]: bigint[] = await Promise.all([
      read(contracts.ETHRegistrar, ethRegistrarAbi, 'MIN_COMMITMENT_AGE'),
      read(contracts.ETHRegistrar, ethRegistrarAbi, 'MAX_COMMITMENT_AGE'),
    ])
    let committedAt: bigint = await read(contracts.ETHRegistrar, ethRegistrarAbi, 'commitmentAt', [commitment])
    const now = (await pub.getBlock()).timestamp
    if (committedAt === 0n || committedAt + maxAge <= now) {
      await send(`commit ${parentName}`, contracts.ETHRegistrar, ethRegistrarAbi, 'commit', [commitment])
      committedAt = await read(contracts.ETHRegistrar, ethRegistrarAbi, 'commitmentAt', [commitment])
    } else skip(`commit ${parentName}`, `committed at ${committedAt}`)

    // Pay while the commitment ages. MockUSDC's mint has no access control.
    const [base, premium]: bigint[] = await read(contracts.ETHRegistrar, ethRegistrarAbi, 'getRegisterPrice', [
      opts.label,
      duration,
      contracts.MockUSDC,
    ])
    const price = base + premium
    const usdc: bigint = await read(contracts.MockUSDC, mockUsdcAbi, 'balanceOf', [account.address])
    if (usdc < price) await send(`mint ${price - usdc} MockUSDC`, contracts.MockUSDC, mockUsdcAbi, 'mint', [account.address, price - usdc])
    const allowance: bigint = await read(contracts.MockUSDC, mockUsdcAbi, 'allowance', [account.address, contracts.ETHRegistrar])
    if (allowance < price) await send('approve MockUSDC', contracts.MockUSDC, mockUsdcAbi, 'approve', [contracts.ETHRegistrar, price])

    for (;;) {
      const ts = (await pub.getBlock()).timestamp
      const ready = committedAt + minAge
      if (ts >= ready) break
      const wait = Number(ready - ts) + 1
      if (opts.warp) {
        log(`  ~ warp ${wait}s (commitment age)`)
        await opts.warp(wait)
      } else {
        log(`  ~ waiting ${wait}s for the commitment to age`)
        await sleep(Math.min(wait, 15) * 1000)
      }
    }
    await send(`register ${parentName}`, contracts.ETHRegistrar, ethRegistrarAbi, 'register', [
      ...registerArgs,
      contracts.MockUSDC,
      zeroHash,
    ])
  }

  // --- 4: q.askqbase.eth and canonical parents ---------------------------------------------
  // setParent records each registry's canonical place in the tree (registry -> name), which
  // reverse traversal and indexers read; resolution itself walks top-down and does not need it.
  async function ensureParent(registry: Address, parent: Address, label: string, name: string) {
    const [current, currentLabel]: [Address, string] = await read(registry, registryAbi, 'getParent')
    if (same(current, parent) && currentLabel === label) skip(`setParent ${name}`)
    else await send(`setParent ${name}`, registry, registryAbi, 'setParent', [parent, label])
  }
  await ensureParent(parentRegistry, contracts.ETHRegistry, opts.label, parentName)

  const qState = await read(parentRegistry, registryAbi, 'getState', [labelId('q')])
  if (qState.status === STATUS.AVAILABLE) {
    // No resolver of its own: q.askqbase.eth inherits askqbase.eth's.
    await send(`register ${qName}`, parentRegistry, registryAbi, 'register', [
      'q',
      account.address,
      qRegistry,
      zeroAddress,
      Q_NAME_ROLES,
      MAX_EXPIRY,
    ])
  } else {
    skip(`register ${qName}`)
    if (!same(await read(parentRegistry, registryAbi, 'getSubregistry', ['q']), qRegistry)) {
      await send(`setSubregistry ${qName}`, parentRegistry, registryAbi, 'setSubregistry', [qState.tokenId, qRegistry])
    }
  }
  await ensureParent(qRegistry, parentRegistry, 'q', qName)

  // --- 5: writer roles -------------------------------------------------------------------
  // grantRoles is disabled on the resolver; root roles are the only grant path.
  if (await read(resolver, resolverAbi, 'hasRootRoles', [WRITER_ROLES, opts.writer])) skip('grant writer setter roles')
  else await send('grant writer setter roles', resolver, resolverAbi, 'grantRootRoles', [WRITER_ROLES, opts.writer])

  // --- 6: the question -------------------------------------------------------------------
  const questionState = await read(qRegistry, registryAbi, 'getState', [labelId(questionLabel)])
  if (questionState.status === STATUS.AVAILABLE) {
    await send(`register ${truncate(questionName, 36)}`, qRegistry, registryAbi, 'register', [
      questionLabel,
      account.address,
      zeroAddress,
      resolver,
      QUESTION_ROLES,
      MAX_EXPIRY,
    ])
  } else skip(`register ${truncate(questionName, 36)}`)

  // Setters take the DNS-encoded name; reads go through resolve(name, text(node, key)).
  const node = namehash(questionName)
  const dnsName = dnsEncode(questionName)
  const readText = async (key: string): Promise<string> => {
    const data = encodeFunctionData({ abi: textResolverAbi, functionName: 'text', args: [node, key] })
    const raw: Hex = await read(resolver, resolverAbi, 'resolve', [dnsName, data])
    return decodeFunctionResult({ abi: textResolverAbi, functionName: 'text', data: raw })
  }
  const desired: Record<string, string> = {
    'qbase.question': question.stem,
    'qbase.canonical': JSON.stringify({ id: question.id, sha256: sha256(stringToBytes(question.stem)) }),
  }
  const calls: Hex[] = []
  for (const [key, value] of Object.entries(desired)) {
    if ((await readText(key)) !== value) {
      calls.push(encodeFunctionData({ abi: resolverAbi, functionName: 'setText', args: [dnsName, key, value] }))
    }
  }
  if (calls.length) await send(`records (${calls.length}) on the question`, resolver, resolverAbi, 'multicall', [calls])
  else skip('records on the question')

  // --- 7: read back through the Universal Resolver ---------------------------------------
  const checks: [string, boolean][] = []
  const finalQuestion = await read(qRegistry, registryAbi, 'getState', [labelId(questionLabel)])
  checks.push(['question expiry is max', finalQuestion.expiry === MAX_EXPIRY])
  checks.push(['question owned by deployer', same(finalQuestion.latestOwner, account.address)])
  // Every level resolves to qbase's resolver: askqbase.eth directly, q.askqbase.eth by
  // inheritance, the question directly.
  for (const name of [parentName, qName, questionName]) {
    const [found]: [Address] = await read(contracts.UniversalResolverV2, universalResolverAbi, 'findResolver', [dnsEncode(name)])
    checks.push([`resolver of ${truncate(name, 30)}`, same(found, resolver)])
  }
  const onChain = await readQuestion(questionName, opts.rpc)
  checks.push(['resolver via Universal Resolver', !!onChain.resolver && same(onChain.resolver, resolver)])
  checks.push(['qbase.question via Universal Resolver', onChain.records['qbase.question'] === question.stem])
  checks.push(['qbase.canonical matches the text', onChain.textMatchesCanonical === true])
  for (const [label, ok] of checks) log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`)
  const failed = checks.filter(([, ok]) => !ok)

  const gas = txs.reduce((s, t) => s + t.gasUsed, 0n)
  const fees = txs.reduce((s, t) => s + t.fee, 0n)
  log(`  ${txs.length} transactions, ${gas} gas, ${formatEther(fees)} ETH`)

  const result = {
    chainId,
    ensContracts: ensCommit,
    generatedAt: new Date().toISOString(),
    deployer: account.address,
    writer: opts.writer,
    writerRoles: `0x${WRITER_ROLES.toString(16)}`,
    contracts: { permissionedResolver: resolver, [`userRegistry(${parentName})`]: parentRegistry, [`userRegistry(${qName})`]: qRegistry },
    names: { parent: parentName, questions: qName },
    question: { id: question.id, name: questionName, node, records: desired },
    transactions: txs,
    checks: Object.fromEntries(checks),
  }
  mkdirSync(dirname(opts.outFile), { recursive: true })
  writeFileSync(opts.outFile, JSON.stringify(result, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n')
  log(`  wrote ${opts.outFile}`)
  if (failed.length) throw new Error(`checks failed: ${failed.map(([l]) => l).join(', ')}`)
  return { resolver, parentRegistry, qRegistry, questionName, node, txs }
}

async function fetchQuestion(api: string, id: string) {
  const res = await fetch(`${api.replace(/\/$/, '')}/api/queries/${encodeURIComponent(id)}`)
  if (!res.ok) throw new Error(`question ${id}: HTTP ${res.status} from ${api}`)
  const q = (await res.json()) as { id?: string; stem?: string }
  if (!q.id || !q.stem) throw new Error(`question ${id}: unexpected response from ${api}`)
  return { id: q.id, stem: q.stem }
}

function truncate(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

function log(line: string) {
  console.log(line)
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      question: { type: 'string' },
      rpc: { type: 'string', default: process.env.SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com' },
      'qbase-api': { type: 'string', default: process.env.QBASE_API ?? 'https://qbase.tech' },
      label: { type: 'string', default: 'askqbase' },
      years: { type: 'string', default: '1' },
      out: { type: 'string', default: new URL('./out/sepolia.json', import.meta.url).pathname },
    },
  })
  const key = process.env.DEPLOYER_PRIVATE_KEY as Hex | undefined
  const writer = process.env.WRITER_ADDRESS
  if (!key || !writer || !values.question) {
    console.error('usage: DEPLOYER_PRIVATE_KEY=0x.. WRITER_ADDRESS=0x.. node setup.ts --question <qid> [--rpc URL] [--qbase-api URL]')
    process.exit(2)
  }
  await setup({
    rpc: values.rpc!,
    account: privateKeyToAccount(key),
    writer: getAddress(writer),
    questionId: values.question,
    qbaseApi: values['qbase-api']!,
    label: values.label!,
    years: Number(values.years),
    outFile: values.out!,
  })
}
