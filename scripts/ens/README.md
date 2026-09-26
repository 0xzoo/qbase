# scripts/ens: askqbase.eth on ENSv2 (Sepolia)

These scripts set up the name tree that qbase's committed wave records are written to. They stand alone: they import nothing from the qbase app, and the app does not depend on them. They were built during ETHGlobal Tokyo 2026 on branch `hack/ensv2`.

```
askqbase.eth                   ETH Registrar (commit, 60 s, register; paid in MockUSDC)
│                              resolver = qbase's PermissionedResolver
│                              subregistry = UserRegistry(askqbase.eth)
└─ q.askqbase.eth              registered in UserRegistry(askqbase.eth), expiry max
   │                           resolver inherited, subregistry = UserRegistry(q.askqbase.eth)
   └─ <qid>.q.askqbase.eth     registered in UserRegistry(q.askqbase.eth), expiry max
                               resolver = qbase's PermissionedResolver
                               qbase.question  = the question text
                               qbase.canonical = {"id", "sha256" of the text}
```

The two registries and the resolver are proxies deployed through the Verifiable Factory. The deployer holds every role on all three. The writer gets `SET_TEXT | SET_DATA | SET_CONTENTHASH` as root roles on the resolver and no admin bits, so it cannot grant, link or upgrade. The question token can have its resolver changed, and nothing else: it cannot be transferred, renewed or given a subregistry.

## Run

```sh
cd scripts/ens
yarn install

node sync-deployments.ts     # refresh deployments.sepolia.json from ensdomains/contracts-v2
node rehearse.ts             # full run on an anvil fork of Sepolia: no keys, no ETH

DEPLOYER_PRIVATE_KEY=0x... WRITER_ADDRESS=0x... \
  node setup.ts --question <qid> [--qbase-api https://<staging>]   # the real run

node read.ts <qid>.q.askqbase.eth    # read the records with only viem and an RPC
```

Requirements: Node ≥ 23.6 (runs the `.ts` files directly) and Foundry's `anvil` for the rehearsal. `SEPOLIA_RPC_URL` overrides the public RPC, and `QBASE_API` (default `https://qbase.tech`) says where the question text is fetched from.

- **`sync-deployments.ts`** reads `contracts/deployments/sepolia` at a contracts-v2 ref and fails unless two things hold: every ABI fragment in `abi.ts` matches the published ABI, and the set is the one that viem's canonical Universal Resolver proxy (`0xeeee…eeee`) actually walks. It checks the second by following the proxy's implementation to its `ROOT_REGISTRY` and on to `.eth`.
- **`rehearse.ts`** starts `anvil --fork-url`, funds three fresh throwaway keys, runs `setup`, and warps time past the commitment age instead of waiting. It then checks the writer's limits (text and data allowed; addresses and self-grants refused; a stranger refused) and runs `setup` a second time, which must send no transactions.
- **`setup.ts`** is idempotent. It reads chain state before each step, finds its proxies by predicted CREATE2 address, and derives the commit secret from a signature by the deployer key, so a run that dies halfway resumes when you run it again. It writes `out/sepolia.json` (addresses, transactions, checks). Commit that file after the real run, because staging reads the addresses from it.
- **`read.ts`** resolves through the Universal Resolver whose address viem ships (never hardcoded) and checks that `qbase.canonical` commits to `qbase.question`.

Measured on the fork (2026-09-26): 13 transactions and 1.88 M gas for the whole setup, of which about 555 k is the question (register plus two records). The deployer needs around 0.01 Sepolia ETH, and MockUSDC is minted in the run.

## Where this departs from plan §7.6, and why

- **The live ENSv2 set is not the one on contracts-v2 `main`.** On 2026-09-26, `main`'s `deployments/sepolia` is the June set, with ETHRegistrar `0xa444…`. The canonical Universal Resolver walks a newer post-audit set (ETHRegistrar `0xabe7…`, root `0x9703…`) whose files exist only on branch `post-audit-2`. A name registered in the June set never resolves through viem. The first rehearsal showed exactly that: every write succeeded and every read returned nothing. `sync` now defaults to `--ref post-audit-2` and refuses any set the canonical resolver does not use. The addresses in the 2026-09-20 plan §3.3 are the stale June set.
- **Post-audit interfaces.** Resolver setters take the DNS-encoded name (§7.6 is right here). `initialize` takes a list of `(account, roleBitmap)` grants. The resolver has no `text()` getter, so reads go through `resolve(name, data)`. `ROLE_SET_DATA` moved to bit 24. The Universal Resolver no longer has `findCanonicalName`, so the check uses `findResolver`.
- **Resolver roles are scoped per record key or root, never per name.** The writer therefore reaches every text, data and contenthash record on every name this resolver serves, and `grantSetterRoles` narrows that to one key, never to one name. A name without its own record falls back to the resolver's default record, which this setup leaves empty.
- **Subregistry and resolver go into the registration itself.** Both proxies are deployed before the commit, because the commitment binds their addresses. That saves the `setSubregistry` calls on the ETH Registry, and `askqbase.eth` never exists without a resolver.
- **The deployer must be a plain EOA.** It receives the ERC-1155 name tokens, so an account with code has to accept them. Anvil's default dev keys fail on the fork: on Sepolia they are public and carry an EIP-7702 sweeper, which rejects the token. The rehearsal uses fresh keys, and `setup` refuses an account that has code.

## AI attribution

These scripts were written with Claude (Opus 5.5, via Claude Code) under the author's direction. The author set the tree, the roles and the isolation rules in the plan. The assistant read the contracts-v2 sources and deployments, wrote the scripts and the rehearsal, and found the deployment-set mismatch and the 7702 issue in rehearsal.
