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

## The commit path (branch `hack/ensv2-commit`)

When a wave closes, the worker commits its result to the question's name (`worker/services/archive/`, migration `0075_wave_commitments`), behind `ENS_WRITES_ENABLED = "1"` (staging only; prod config leaves it unset).

1. **Bundle.** Canonical JSON (RFC 8785), `schema: "qbase.wave.v1"`: the question, the wave's rule (`open`, `world_id:proof_of_human`, a holder gate by contract, never its FID list), `n`, `n_verified` (a count of World ID verifications, never nullifiers), the tally (the results page's own count: latest per person, Public + Anon) and the wave's **Public** answers up to its close. Anon answers are counted and never listed; Secret answers are in neither.
2. **Arweave.** One ANS-104 data item signed by qbase's archive key (secp256k1, not the ENS writer), posted to ArDrive Turbo; under 100 KiB needs no credits. If the post fails, qbase serves the bundle at `/api/archive/waves/:id/bundle` and `contenthash` stays unset.
3. **ENS.** One `multicall` on the resolver from the writer: `qbase.waves`, `qbase.wave.<id>` (closed_at, n, n_verified, gate, published_by, tally_sha256, bundle), `qbase.wave.<id>.hash` (data, the bundle's sha256) and `contenthash = ar://<id>` (`0x90b2ca05` + 32 bytes, checked against `@ensdomains/content-hash`). The writer cannot register names; a fourth key, the **namer**, holds only `ROLE_REGISTRAR` on `UserRegistry(q.askqbase.eth)` (`grant-namer.ts`, run once by the deployer) and names a question when its first wave opens (the `*/10` sweep) or at commit if the sweep has not. ENSv2 reverts a registration of a registered label, so the namer can create question names and cannot alter one. Names go to the deployer with the same roles `setup.ts` gives them.
4. **Verify.** `GET /api/archive/waves/:id/verify`: `chain.matches` refetches the bundle from Arweave and compares its hash to the record read through the Universal Resolver; `live.matches` recomputes the tally from D1 and compares it to the bundle's. Answers on a closed wave are frozen (value edits, deletes and re-scopes to Secret answer 409 `wave_closed`; Public ↔ Anon is allowed, the tally does not move; after commit, going Anon no longer takes a name off the Arweave bundle), so only an edit outside the API flips `live`. `node read.ts <name>` does the chain half with no qbase in the path.

**Turbo in workerd (spike, 2026-09-26).** `@ardrive/turbo-sdk/web` bundles and runs in workerd with `nodejs_compat` once its optional `x402-fetch` peer is aliased away, and a real upload from local workerd succeeded (`winc: "0"`). It adds about 3.6 MB to the worker for one POST, so the worker builds the same bytes with viem instead, matched byte for byte against `@dha-team/arbundles` 1.0.4 (the SDK's signer). Items are readable at `turbo-gateway.com` at once and at `arweave.net` after settlement.

**First commit (staging, 2026-09-26):** wave `5a3f8d59-16ad-44d7-84fd-299ffebaca1a` on `8adeb535-….q.askqbase.eth`, bundle `ar://RmbuR5MXi_g8sGRjY9J0eSE25seGJA-OpXwg8ALgwqI`, Sepolia tx `0xf892ee01317949b748d29f33bca63e3b811f4b58e05f7831862af68342a39f44`. Archive key address: `0x8b3CE1C7fdE84aD9ec387B9D782eD2Ec64aE9Acd`. The staging wave was seeded by SQL with three demo accounts.

**Second commit (staging, 2026-09-26), named at open:** question `2b0c7155-ee81-4d5a-b564-d1db83aa6ce3` registered by the namer (`0x3Df6b0E14C55A59De6C485E049D5c2bBD26fc179`, role granted in `0x889747b8…465f`) while its wave was open; wave `73d4d6ab-1276-44a9-a44a-b62dcaed3151` committed with one Anon row (counted, and listed under an anon receipt hash: that bundle used the short-lived `qbase.wave.v2` format, since withdrawn; receipts made an anon vote provable by its holder, which is wrong for waves that decide anything): bundle `ar://DxZhF84IGd1oUp2EkP12Sy8sUfKbP7ssCzcMW3u8xOs`, Sepolia tx `0x84189f2ef71df8804084c93f62c08f3ee73f0d7dfa2392735c0afe29040dcce6`.

## Mainnet name

`askqbase.eth` is registered on mainnet ENS v1 (2026-09-27, verified on chain): owner (registrant) and manager `0x24aBd454d60b3cf6053bFC848A91ca84bA201ef2`, a dedicated mobile wallet used for nothing else; unwrapped; **expires 2027-09-26 15:17 UTC** (90-day grace after). Anyone can pay a renewal from any wallet. It carries no records: nothing reads mainnet until ENSv2 launches there and the name migrates, at which point the Sepolia tree is recreated from D1 (`wave_commitments`) and the Arweave bundles, which do not change. Custody to move to a hardware wallet or an independent multisig later.
