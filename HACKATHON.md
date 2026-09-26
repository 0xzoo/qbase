# ETHGlobal Tokyo 2026

qbase entered the **Continuity Track**. It has been in development since 2024 and runs in production at https://qbase.tech.

## What existed before the event

Everything up to and including the tag **`pre-ethglobal-tokyo-2026`** (`d8d4693`): questions, answers and the Public / Anon / Secret audiences, polls, Farcaster sign-in, passkeys, results pages. Hacking started Fri Sep 25 21:00 JST. Everything below was built after that, in the commits listed.

## What was built during the event

### 1. One account, any login
A qbase account used to be a Farcaster ID. It is now its own account (opaque id), and Farcaster, a passkey, an Ethereum wallet (Sign-In with Ethereum, ENS name as the label, bound to the address) and World ID (Sign in with World, OIDC) are all credentials for it.
- Branch `feat/account-root`, merged to `main`: `c148579` … `f0ebf0b` (schema + backfill, reversible fid → account cutover, SIWE + World login + credential linking), fixes `8f8e887` … `e870319`, `8b9dea1`, `fc16611`, `8ae3138`; handles `379bcb5` … `f294356`.
- Live in production.

### 2. One human, one answer (World ID)
A poll can require a World ID proof of human at the moment you answer. The worker signs a per-poll request (`qbase-wave-<poll id>`), verifies with World's v4 verify API, and claims the nullifier under `UNIQUE (action, nullifier)` before the answer is written. One human answers a poll once, whichever account they use; nothing links answers across polls.
- Branch `hack/world-idkit`, merged to `main`: `617725d` … `d24f76b` (table, service, routes, web flow, tests), fixes `11478b7`, `acb1430`, `b47d33f`.
- Code: [`worker/services/WorldIdService.ts`](worker/services/WorldIdService.ts), [`worker/routes/polls-world.ts`](worker/routes/polls-world.ts), [`src/hooks/useWorldIdAnswer.tsx`](src/hooks/useWorldIdAnswer.tsx), [`migrations/0073_world_verifications.sql`](migrations/0073_world_verifications.sql).
- Runs on qbase.tech against **World's sandbox** for the event: identities are simulated.

### 3. A record anyone can check (ENSv2 + Arweave)
Every question gets a permanent ENSv2 name under `askqbase.eth` (no expiry, not transferable; the writer key can only set records). When a poll closes, its public bundle (rule, count, tally, only the answers people made public) goes to Arweave, and its hash, `ar://` contenthash and summary are written to the question's name in one multicall. A verify endpoint compares the on-chain record with the live database.
- Branch **`hack/ensv2-commit`** (staging + Sepolia only, never prod): `83f3e43` … `d98d351` (`scripts/ens`: sync, setup, read, anvil rehearsal; `askqbase.eth` live on Sepolia), `935882c` … `31c011a` (closed-poll freeze, migration 0075, Arweave via ArDrive Turbo, commit job, archive + verify API, results line), `eca6bef` (namer key), `ead2014` (0077).
- Code: `worker/services/archive/` and `scripts/ens/` on that branch; `scripts/ens/README.md` explains the tree, roles and how to run.
- **Sepolia now, mainnet later:** `askqbase.eth` is registered on mainnet (ENSv1) and moves to ENSv2 when ENSv2 launches there.

## Judge path

- **Production (pieces 1 and 2):** https://qbase.tech. Sign in with any method; Settings → Sign-in methods shows them on one account. Create a poll with "Verified humans only (World ID)"; answering asks for a World ID proof (World sandbox / simulator).
- **Testnet deployment (piece 3):** https://qbase-dev.z00.workers.dev
  - A committed poll: https://qbase-dev.z00.workers.dev/poll/340bc23b-db56-4cb1-8ef1-e82c1bd5c3eb/results (World ID gated, 1 verified answer, committed to ENS + Arweave).
  - Verify it: `curl -s https://qbase-dev.z00.workers.dev/api/archive/waves/340bc23b-db56-4cb1-8ef1-e82c1bd5c3eb/verify | jq '{chain: .chain.matches, live: .live.matches}'`
  - Read it without qbase: on branch `hack/ensv2-commit`, `cd scripts/ens && node read.ts ff0bcdd4-8a15-4cb5-9d02-e2fb9f4be3c0.q.askqbase.eth`

## AI use

Built with Claude Code (Anthropic's Claude Opus models) as a coding assistant under the author's direction. The author designed the three pieces and made the product, security and privacy decisions; Claude Code wrote much of the implementation to those designs (the account migration and call-site classification, the World ID flow, the ENS scripts and commit path, the verify endpoint, tests) and helped debug the integrations. Commits it contributed to carry a `Co-Authored-By: Claude` trailer. See also the README's AI attribution section.
