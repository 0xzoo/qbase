# AGENTS.md - qbase

**Stack:** React 19 + TypeScript + Vite (SWC) + Cloudflare Workers + D1 + Tailwind
**Production:** https://qbase.tech
**Farcaster URLs:** Use `farcaster.xyz` (warpcast.com is defunct). Cast links: `https://farcaster.xyz/~/conversations/${hash}`

## Quick Context

Qbase is a Farcaster-native Q&A platform. The worker handles meta injection, OG images, API endpoints, AI query parsing, and snap rendering. The SPA handles all client-side UI.

## Storage Architecture

**Four storage layers** based on data privacy:

1. **D1 (prod-qbase)** — Public content & metadata: queries, answers, profiles, topics, quizzes, FC integration
2. **QStorage (Quilibrium S3)** — Private/Allowlist encrypted blobs (client-side AES-GCM, worker sees ciphertext only). Also supports **static website hosting** (standard S3 IndexDocument/ErrorDocument config). Example: `https://<bucket-name>.<id>.qstorage.quilibrium.com/`
3. **KV** — Edge caching: `KV_USER_PROFILES`, `KV_USER_POINTS`, `KV_FRAME_NOTIFICATIONS`, `BARTLET_SESSIONS`
4. **Vectorize** — Semantic search: `QINDEX` (questions), `AINDEX` (answers). Duplicate threshold 0.95

**Answer storage routing** (handlers under `worker/handlers/answers/`: `create.ts` / `read.ts` / `mutate.ts` + `index.ts` re-export):
| Audience | D1 | QStorage |
|----------|-----|----------|
| Public | value in plain | - |
| Anon | value = anon bot fid + D1 `anon_attributions` | - |
| Private | value = `'[encrypted]'` placeholder | encrypted blob |
| Allowlist | value = `'[encrypted]'` placeholder | encrypted blob w/ allowlist FIDs |

QStorage is server-only — every read/write goes through `QStorageService.fromEnv(env)`. The previous `/api/qstorage/*` HTTP proxy is gone (closed an unauth blob-read/write hole). For `Private` and `Allowlist`, the read handlers gate on author / allowlist-membership before consulting QStorage; the `GET /api/users/:fid/answers` endpoint refuses to leak Private payloads or `is_own_anon` flags to anyone but the responder themselves.

**Quiz answers are Answers rows too** (`worker/services/quiz/`, CONTENT-PLAN.md §6 V1): a private `createQuizCompletion` writes one `Answers` row per quiz item against the item's canonical question (`q_bartlet_*` / `q_values_*` / `q_apperception_*`, registered by the admin-register-*-queries routes) — audience `Private`, `value = '[encrypted]'`, content sealed at `answers/private/<id>` exactly like a Private in-feed answer, `poll_id` NULL, `quiz_completion_id` linking back, `answer_meta` seeded and `priv_answers` bumped; no points, no vectors, no cast. `canonicalAnswers.ts` translates each quiz's answer shape into the value / `answer_data` conventions above (Likert position 0–4 → scale `"1"`–`"5"`). The write is all-or-nothing per completion and is skipped entirely when a canonical question is missing from `queries`; `quiz_completions.answers_materialized_at` records success and `POST /api/admin/quiz-answers-backfill` (cursor-driven, idempotent) sweeps whatever is still NULL — past completions, failed live writes, quizzes registered late. Re-scope is `PUT /api/answers/:id`, like any other row. **Owner surface (V2):** `GET /api/me/quiz-answers` lists the caller's rows grouped by completion with values opened server-side; `POST /api/me/quiz-answers/:completionId/audience {audience: Private|Anon|Public, answer_ids?}` re-scopes a whole quiz or a subset through `applyAnswerUpdate` (`worker/services/quiz/QuizVisibilityService.ts`); pages `/me/answers` and `/me/report`. **Correlation report:** `worker/services/quiz/QuizStatsService.ts` builds one bucketed vector per person from their latest completion per quiz (Likert → disagree / neutral / agree, mc → label, text skipped), keeps pairwise lifts only with support (group ≥ 10, at least 5 on each side of the cell, lift outside [1/1.5, 1.5]), caches the aggregate in `quiz_stats` (migration 0071; daily cron, `POST /api/admin/quiz-stats/rebuild`, or lazily after 24 h), and `GET /api/me/quiz-report` intersects it with the viewer's own vector.

**MC/Checkbox snap answers:** All MC answers (snap + API) are append-only — always INSERT, never UPDATE. Old answers preserved for time-series. Latest row per user (by `created_at DESC`) is canonical. `answer_type_id = 2` (MC) and `4` (checkbox). Count queries use CTE with ROW_NUMBER via `worker/services/AnswerCountService.ts` to only count each user's latest answer. `pub_answers` only incremented on first answer per user.

**Scale answers:** `Answers.value` stores the **raw numeric** as a string (e.g. `"15"`); `answer_data` carries `{"index": N}`. Human-readable labels (`"Mostly Yes"`, `"Leaning Disagree"`, `"Neutral"`) are computed at render time via `src/lib/scale.ts` (`getScaleLabel` / `formatScaleAnswerValue`) using the question's `scale_config`. For ranges > 7, only the numeric is shown — `Mostly`/`Leaning` only fits 5- and 7-point scales. The global feed endpoint `/api/answers` joins `q.type` and `q.scale_config` so `AnswerCard` can format. Migration `0051` backfilled legacy rows whose `value` had the bug-fallback string `"0 (15)"` back to `"15"` using `answer_data.index`.

**Date answers (`answer_type_id = 5`):** `Answers.value` stores the raw ISO string — `YYYY-MM-DD` for date-only questions, `YYYY-MM-DDTHH:mm` when the question's `date_config.include_time` is set. `answer_data` carries `{"iso": "..."}`. Display formatting lives in `src/lib/date.ts` (`formatDateAnswerValue`); it parses the iso (date-only is anchored to local `T00:00` to avoid the JS-Date-as-UTC day-shift) and renders via `toLocaleDateString` / `toLocaleString`. The renderer keys off `question.type === 'date'` — no question metadata needs to flow through `/api/answers` because the iso is self-describing. Date questions do **not** render as a Farcaster snap (`src/lib/snapEligibility.ts` falls through to `default → false`); the cast embed shows the "Answer on qbase" miniapp button. Schema lives in migration `0056_add_date_answer_type.sql` (answer_types row id 5 + `queries.date_config` JSON column).

**Polls = waves over questions (`polls`, `Answers.poll_id`, `poll_options.poll_id`):** A question is the durable atom and is *always answerable*. A poll is a time-gated **wave** over a question: one `polls` row (`id`, `question_id`, `closes_at` **NOT NULL**, `eligibility_gate`, `options_config`, `author_fid`, `cast_hash`, `channel_id`, `kind` = `'measure'` | `'decide'` (decide arrives in Track D), `created_at`). Gates and open-options config live on waves only — `queries` no longer has `closes_at` / `eligibility_gate` / `options_config` (dropped in migration `0068`). Answers cast through a wave carry `Answers.poll_id`; direct answers carry NULL. A wave's tally is `WHERE poll_id = P`, latest per (wave, user) — every reader in `AnswerCountService` / `AggregateResultsService` takes an optional `pollId`; the question-level view counts everything. Write-in options belong to the wave (`poll_options.poll_id`, `UNIQUE(poll_id, label_norm)`); each new wave re-seeds its option set from the question's `a_options`. Spec: `docs/specs/question-wave-attribution.md`; plan: `docs/plans/wave-governance-roadmap.md`.

**Opening a wave** (`worker/services/WaveService.openWave`, one path for both entry points): `POST /api/polls { question_id, closes_at, eligibility_gate?, options_config?, channel_id?, resnapshot? }` (auth, **free**) opens a wave on an existing question — the re-ask primitive, zero inherited stats; `POST /api/queries` with `closes_at` creates the question *and* its first wave (response carries `poll_id`). `closes_at` is required and capped at 1 year; `eligibility_gate` and `options_config` without `closes_at` are rejected. A gate whose params (type/contract/chain/min_balance) match a prior wave **copies that wave's `snapshot_fids`** instead of re-running Alchemy + Neynar; `resnapshot: true` forces a fresh snapshot. Both creation dedup gates (exact stem 400, vector 0.98) return `code: 'duplicate_exact'|'duplicate_similar'` + `existing_id` + `reask`, and the client offers "ask again as a new poll" (`/create-poll?question=<id>`). The `@polls` bot casts a wave with the wave's own snap URL; `/api/farcaster/cast` takes `pollId` to record `polls.cast_hash`. Wave API: `GET /api/polls/:id`, `/eligibility?fid=`, `/aggregate`, `/options` (GET/POST write-in), `/options/all`, `PATCH /options/:oid`; `GET /api/queries/:id/polls` lists a question's waves. `GET /api/queries/:id` (optionally `?poll=<id>`) ships `current_poll` (the wave in play: the named one, else the open wave) plus `options_config` / `poll_options` derived from it. Snap UI (`src/components/poll/PollCreationForm.tsx`, route `/create-poll`) carries the entry point; `?question=<id>` is re-ask mode.

**Snap surfaces for waves:** `/snap/poll/:id` is the wave's own surface — answers attribute to it and after close it shows locked results (its cast keeps working forever). `/snap/question/:id` answers through the question's **open** wave while one is live, else the question itself (always open, `poll_id` NULL). The wave context rides on `SnapService.QueryRow` (`poll_id`, `options_config`, `snap_path`); every scene targets `snapBase(query)` so pagination, write-ins and compact mode stay attributed, and compact-mode HMAC is scoped to the surface (`poll:<id>` vs the question id). Results surfaces: `/question/:id/results` (every answer) and `/poll/:id/results` (the wave, with the vote-change signal `churn` + public `changes` from `getVoteChurn`); `/api/og/results/:id` resolves a wave id first, then a question id.

**Question typology (`queries.taxonomy` JSON):** every new question is classified by `AIService.classifyQuestion` → `worker/services/taxonomy/` (spec `docs/specs/question-typology.md`). The classifier is **Gemini 3.1 Flash Lite via OpenRouter** (`openRouterClassifier.ts`, reasoning effort low, needs `OPENROUTER_API_KEY`; same path as the values narratives; chosen over Haiku 4.5 and GLM-5.3-flash on gate + run-to-run determinism — GLM flips labels between identical runs; override with `CLASSIFIER_MODEL` + `CLASSIFIER_REASONING` vars, and re-check with `scripts/taxonomy-gate.ts --models=…` first) and asks for five independent axes — `referent` self|world, `mode` stance|report|claim, `tense`, `volatility` stable|volatile|event, `intent` measure|request — plus facets (`frame`, `construction_type`, `content_tags`, `topics`, `temporal_markers`, `sensitivity`, `safety_flag`, `is_question`). Every routing label is **derived in code** (`derive.ts`), never asked for: `primary_type` (claim/future → predictive, claim → knowledge, volatile & not future → recurring, report/future → prospective, else identity), `resolvability` never|self_only|later|now, `signal`, `wave_relevance`, `clout_eligible`. Rows carry `taxonomy_version: 2`, `classifier`, `classified_at`; v1 rows (3B decision tree, `legacyClassifier.ts`) keep working — the legacy path is the fallback when OpenRouter fails and the baseline for `scripts/taxonomy-gate.ts`. `intent = request` (help/advice/how-to) is a Q&A thread, not a tally: `POST /api/queries` rejects a non-text request with 400 `request_needs_thread`; text requests store `intent` and `GET /api/queries/:id/aggregate` exposes `question.intent` so the results page labels the thread. Dev-only `POST /api/test/taxonomy-classification` runs the canonical test set (`testSet.ts`, shared with the gate script; body `{classifier: 'openrouter'|'legacy'}`). Backfill/diff of existing rows: `scripts/reclassify-questions.ts` (dry-run by default; `--apply` writes agreeing rows, `--apply-all` after review, `--revert --from=<report>` undoes; `--model=` for trials).

**Holder snapshot pipelines**: Two services with mirrored output shapes — `worker/services/NftHolderSnapshotService.ts` (`snapshotNftHolders`) for NFT, `worker/services/TokenHolderSnapshotService.ts` (`snapshotTokenHolders`) for ERC-20 by minimum balance. Both run at poll-creation, both end with `Neynar bulk-by-address` (350-batch) → resolved FID list stored inline on `eligibility_gate.snapshot_fids` so the per-vote check is a list lookup. NFT pipeline: Alchemy `getOwnersForContract` paginated, capped at `MAX_HOLDERS=50k`. Token pipeline: viem `readContract` for `decimals()` + `symbol()`, Alchemy `getOwnersForContract?withTokenBalances=true` (works for ERC-20s on the NFT API endpoint), filter `BigInt(balance) >= parseUnits(min_balance, decimals)`, capped at `MAX_HOLDERS_SCANNED=100k` rows scanned. Stored gate JSON for token_snapshot adds `min_balance` (human form), `min_balance_wei` (raw), `decimals`, and (best-effort) `symbol`. **30s ceiling**: synchronous snapshot inside a CF Worker request hits a ~30s wall-clock ceiling; oversized collections are rejected with a clear error. Async/durable-object snapshotting is a v1 problem.

**Eligibility enforcement** (`worker/services/EligibilityService.ts`) is **wave-scoped**: `check(env, poll, fid)` takes a `polls` row and returns `{eligible, reason: 'no_gate'|'open'|'closed'|'not_holder'|'unknown_gate', closesAt?, pollId?}`. Order: `closes_at` past → `closed`; gate null → `no_gate`; FID in `snapshot_fids` → `open` else `not_holder`. `checkById(env, pollId, fid)` loads the wave; `checkQuestion(env, questionId, fid)` resolves the question's current wave (`PollService.getCurrentPoll`, open or closed) and returns `no_gate` for a question with no wave. Per-FID results cached 1h in `KV_USER_PROFILES` under `poll:eligible:<pollId>:<fid>` — two waves on one question never share an entry. **Anon does not bypass the gate**: the real FID is checked, then the answer is stored anon. A direct answer (no `poll_id`) never hits eligibility. Call sites: `worker/handlers/answers/create.ts` (optional `poll_id`; the wave must belong to `q_id` → else 400 `poll_mismatch`; 423 `poll_closed` / 403 `not_eligible`; stamps `poll_id` on every audience's INSERT), `worker/routes/snap.ts` GET+POST (checks the resolved wave before any write and renders a type-agnostic locked scene — MC/scale/checkbox keep their chart with the lock reason, text gets `lockedSnap`; an unknown viewer on a holder-gated wave sees the question and the verified POST decides), `POST /api/polls/:id/options` (write-in votes), and the client probe `GET /api/polls/:id/eligibility?fid=` (used by `useEligibility`; `GET /api/queries/:id/eligibility` still answers for the current wave). The full `snapshot_fids` list never ships to the wire (`PollService.toPublicPoll` strips it).

**Client lock UX**: `src/hooks/useEligibility.ts` probes `/api/polls/:id/eligibility` for `question.current_poll` (time lock resolved locally; no wave → no probe); `src/components/PollLockBanner.tsx` renders the reason above a disabled `QuestionRenderer`; `src/components/WaveStrip.tsx` shows the wave in play, all waves with results links, and the re-ask link. `QuestionSlide` sends `poll_id` for the wave in play. Fail-open on probe error — better to let the server reject than to lock a legitimately eligible viewer because of a network blip.

**Aggregate result pages** (the shareable "finding" artifact, shipped `3177deb`): every question has a public results page at `/question/:id/results` (SPA: `src/pages/QuestionResultsPage.tsx`). Three pieces: `GET /api/queries/:id/aggregate` (`worker/services/AggregateResultsService.ts`, wired in `worker/routes/queries.ts`, 60s cache) returns a unified distribution — MC/checkbox reuse `AnswerCountService` latest-per-user CTEs, scale gets a per-value histogram, text gets responder count + recent answers; **Public/Anon only — Secret/Allowlist never enter aggregates**. `GET /api/og/results/:id` (`OGService.generateResultsImage`, 5-min cache) renders a 1200×630 bar chart so casting the results URL shows the distribution in-feed. `worker/routes/meta.ts` injects `fc:miniapp` on `/question/:id/results` pointing at that chart (no snap Link header — the cast artifact IS the chart; the page links back to the question). Counting semantics intentionally match the snap result scenes so all surfaces report the same numbers. Known nit: emoji in stems render as tofu in OG output (Albert Sans has no emoji glyphs; resvg loads no system fonts).

**Browser quiz UI (apperception / values / bartlet):** Each of the three Farcaster-snap quizzes is also takeable in a normal browser at `/quiz/{slug}` via the generic `src/pages/QuizPage.tsx`. A click on `/snap/{slug}` from a browser hits the same worker content-negotiation as before (snap clients get JSON; crawlers get OG-tagged HTML), but the SPA shell that the HTML serves boots and `<Navigate>`s the browser to `/quiz/{slug}`. The page needs any qbase sign-in (the quiz taker is keyed by account; `webTaker`) and talks to per-quiz JSON endpoints — `GET /api/{slug}/web/state`, `POST /api/{slug}/web/start`, `POST /api/{slug}/web/answer` — which mirror each quiz's snap state machine but auth via `requireFlexibleAuth` (`worker/middleware/auth.ts`) so both SIWF session tokens and Quick Auth JWTs work. sid is persisted client-side in `localStorage['qbase:quiz:{slug}:sid:{accountId}']` so mid-quiz reload resumes (a sid saved under the fid before the account cutover is moved over on first read); completion runs the same airdrop / open-text classifier / `createQuizCompletion` pipeline as the snap path before redirecting to each quiz's existing result page (`/apperception/result`, `/values/result`, `/bartlet/unlock`). Note: `worker/routes/meta.ts` still treats `/quiz/:id` as a created-quiz miniapp deeplink and injects an `fc:miniapp` tag pointing at `/api/og/quiz/{id}` — for the three known snap-backed slugs this is harmless but cosmetically wrong (the OG endpoint returns 404 for non-DB ids); fix on the to-do list.

**Values compatibility (`/values/compare`, CONTENT-PLAN §7.5):** `compare(a, b)` over two values completions — `GET /api/values/compare?a=<completion id>[&b=<completion id>]` (`worker/services/values/compareService.ts` → `compare.ts`) and `GET /api/values/compare/me` (the caller's latest values completion). Reads the sealed `quiz_completions` rows through `readCompletionAnswers` (KV sessions expire after 30 days; completions are the durable record). The **completion id is the capability**: a random UUID only its owner sees, so a link carrying it is one the owner chose to hand out — a pair view needs no sign-in, a single `a` resolves the signed-in caller's latest completion as `b` (response `status`: `ok` | `sign_in` | `no_completion` | `self`). Per-dim deltas, Likert/forced items both answered with a verdict (agree / disagree / neutral), the three most surprising of each (verdict against the profiles' probed dims), prose from OpenRouter Haiku 4.5 with a templated fallback, cached in `VALUES_SESSIONS` under `compare:v<COMPARE_VERSION>:<a>:<b>`. **Open-text answers never enter a comparison.** Page `src/pages/ValuesCompare.tsx` (hub / teaser / pair), shared radar `src/components/ValuesRadar.tsx` (+ `src/lib/valuesDims.ts`), `QuizPage` honours `?next=<same-origin path>` on completion, `/values/compare` gets an `fc:miniapp` tag carrying its query string (`routes/meta.ts`). Notes: `docs/quizzes/compatibility/NOTES.md`.

**Farcaster is a surface: nothing is cast unless someone shares it.** Creating a question casts nothing (`POST /api/queries` defaults to `cast_mode: 'none'` via `resolveCastMode`; `'server'` / `'client'` stay for API callers that ask, the web client never does). Saving an answer casts nothing (the two `ANSWER_CAST_QUEUE` enqueues in `worker/handlers/answers/create.ts` are gone — Public text answers used to go out from `@4n0n`; the queue binding and `worker/queues/answerCastConsumer.ts` stay only so in-flight messages drain). The only automatic cast left is **@polls announcing a poll** (`PollCreationForm` → `/api/farcaster/cast` with `usePollsBot`), which organic replies and snap answering rely on. Everything else is an explicit share from `QuestionSlide`'s share menu (`ShareButton` with `actions`): "Share to Farcaster" for a viewer with a linked fid or in the mini app — an uncast question goes @polls (a poll in play), the user's signer, or their composer with the hash anchored through `POST /api/queries/:id/cast-hash`; an already-cast question opens the viewer's own composer — and "Share anonymously via @4n0n" for the author of an anon question only. `/api/farcaster/cast` enforces that: `useAnonBot` must name an anon question the requester wrote (`isAuthor` over the sealed attribution), and `GET /api/queries/:id` carries `viewer_is_author` for the menu. A user's own named answer has a share icon that opens their composer (never for Anon). Question likes are Farcaster reactions on the question's cast, so the like button shows only once a question is cast, read-only without a linked fid; native question likes are an open follow-up.

## Paid council (`docs/specs/paid-council.md`)

The council (qlaude / qemini / chatqpt via the `ORACLE` Durable Object) is summoned from the web (`POST /api/queries/:id/council`, panel `src/components/CouncilPanel.tsx` inside `QuestionSlide`) or by a "`@qgent council`" reply cast (`/webhooks/hypersnap` → `dispatchCouncil`); both go through `worker/services/CouncilService.summon` (`routes/council.ts`, registered before the generic query handler). Order: question exists → already answered (thread returned, nothing charged; a summon whose every model failed leaves only error rows and can be retried) → replay guard (`council_summons.summon_cast_hash` UNIQUE; per-question KV lock for web double-clicks) → 3 summons / FID / hour → stake gate → dispatch → persist `council_responses` (each model's full text + last cast hash) → `OracleEscrow.recordDeduction` on Base. Migration `0069`. **Gate:** `COUNCIL_PRICE_QQ` (whole $QQ; `"0"` = free) with `ORACLE_ESCROW_ADDRESS` + secret `ORACLE_AGENT_KEY` (`worker/services/OracleEscrowService.ts`, viem on Base, 30 s KV balance cache); price set without an escrow → 503 `escrow_unconfigured`, never free by accident; no stake → 402 `stake_required` (web) / Q replies "stake at qbase.tech/stake" (cast). Read surfaces: `GET /api/council/config`, `GET /api/council/stake` (auth), `GET /api/queries/:id/council` (thread + viewer's `can_summon`). Client stake page `/stake` (`src/pages/StakePage.tsx`: approve + `deposit(fid, amount)`, `withdraw` after the 7-day window, wagmi + `WalletConnectModal`). Tests: `test/services/council.test.ts`, `test/routes/council.test.ts`.

## Auth

Three modes: Farcaster AuthKit (web, SIWF) + Frame SDK (MiniApp Quick Auth) + Passkey (Quilibrium Ed448). `src/context/AuthContext.tsx` is now a ~430-line orchestrator that dispatches to three per-mode hooks under `src/context/auth/`: `useFarcasterMiniAppAuth`, `useFarcasterWebAuth`, `usePasskeyAuth`. Passkey backend: `worker/services/PasskeyAuthService.ts`.

**SIWF**: `/api/auth/nonce` writes a single-use nonce to KV (10min TTL); `/api/auth/session` consumes it before signature verification — replay → 401. The web hook owns one `exchangeSiwfForSession()` helper with a Promise-mutex per nonce that coalesces concurrent calls (server-side single-use is the actual replay guard; the client-side mutex just dedupes in-flight exchanges).

**Passkey**: login requires an Ed448 signature over a server-issued challenge (`GET /api/auth/passkey/challenge` → `POST /api/auth/passkey/login` with the signature). Server verifies via `@noble/curves/ed448` against the registered public_key, single-use (challenge consumed before verification). Client-side, the local Ed448 private key is wrapped with AES-GCM keyed off the WebAuthn PRF extension when available (Chrome/Edge ≥ 132, Safari ≥ 18) — see `src/crypto/prfWrap.ts`. Legacy plaintext keys lazy-upgrade on first sign-in. Firefox / older Safari emit a console warn and stay plaintext. **`localStorage['qbase-passkeys']` is preserved across logout** — passkeys are re-auth credentials, not session state; wiping them strands the user (WebAuthn credential + server public key both survive logout). The PasskeySignInModal exposes "Clear passkey & create new" for explicit resets. Stored shape supports `string | number[] | Uint8Array | ArrayBuffer` on read (legacy rows used multiple formats); writes normalize to a JSON-array string via `normalizePublicKeyForStorage`.

**Rate limits** apply to every state-changing `/api/auth/*` route (60/min nonce, 10/min session+login, 5/min register+link, 30/min challenge). Atomic per-IP via `RateLimitDO` (Durable Object sharded by `idFromName(ip)`); `RateLimitService.checkLimit` is a thin wrapper around the DO call. Sub-bucket per endpoint (e.g. `'auth:session'`) is stored as a key inside the per-IP DO. Failure mode: DO call throwing fails open — a rate-limit outage shouldn't 5xx the whole API.

Known bug: stale passkey + missing backend → modal dead loop, fix by clearing `qbase-passkeys` + reload.

**User identity:** `fid` is the primary key of the Users table (no more auto-increment `id`). All answer/query FKs use fid directly. `UserService.parseUser()` sets `id = fid` for backward compat with callers using `user.id`. `resolveUserId()` is gone — snap handlers use `ensureUserByFid()` + fid directly as `user_id`.

**Onboarding (currently disabled):** The `/onboarding` route + guard were removed — every user today comes in with a Farcaster identity, and `AuthContext`'s `needsOnboarding` short-circuits to `false` for any user with `fid + sessionToken|quickAuthToken` or `profile_source = 'farcaster'`. The `needsOnboarding` state, the gates, and `OnboardingPage.tsx`/`components/Onboarding/*` remain in place as scaffolding for the future flow that creates Farcaster accounts for non-FC users (different shape from the old username/avatar/bio flow). **Invariant still holds:** Farcaster identity is established FIRST, before passkey creation.

→ **Signer flow, SIWN details, endpoints, Neynar config:** `.brv/context-tree/reference/signer-flow.md`

## Points (UI stripped, backend intact)

Points/QP display removed from Header. Backend `PointsService`, `KV_USER_POINTS`, `/api/points` route still exist for future use.

## Cloudflare Bindings (worker `env`)

- `DB`: D1Database (prod-qbase)
- `R2`: R2Bucket (qbase-images — bartlet archetype images, avatars)
- `QINDEX` / `AINDEX`: VectorizeIndex
- `KV_FRAME_NOTIFICATIONS`, `KV_USER_PROFILES`, `KV_USER_POINTS`, `BARTLET_SESSIONS`: KVNamespace
- `QGENT`: DurableObject (Q Agent analysis loop)
- `RATE_LIMIT`: DurableObject (`worker/agents/RateLimitDO.ts`) — atomic per-IP rate limiter, sharded by `idFromName(ip)`. Replaced the prior KV-backed counter that had a read-modify-write race on `/api/auth/*`. `RateLimitService.checkLimit` is the thin wrapper.
- `ANSWER_CAST_QUEUE`: Queue producer (DLQ: `qbase-answer-casts-dlq`) — no longer written (answers are not auto-cast); `worker/queues/answerCastConsumer.ts` stays to drain in-flight messages and can be removed with the binding.
- `AI`: Workers AI (embedding model `@cf/baai/bge-base-en-v1.5`)

## Worker Entry (worker/index.ts)

Route hierarchy (order matters):
1. Snap endpoints — `handleSnapRoutes` (/snap/question/:id, /snap/bartlet, /snap/bartlet-dev)
2. Meta tag injection — `handleMetaRoutes` (/quiz/*, /ask/*, /question/*, /questions, /about)
3. OG image generation — /api/og/*
4. API routes: auth, admin, answers, users, farcaster, queries, topics, similarity, miniapp, points, settings, q, bartlet API, quiz-completions
5. Webhook routes: /webhooks/* — Hypersnap (HMAC-SHA512 over raw body, `X-Hypersnap-Signature`); Neynar miniapp lifecycle is **JFS-signed** (parsed via Ed25519 + Hub `onChainSignersByFid` lookup, not HMAC)
6. Static assets via `env.ASSETS` (SPA fallback serves index.html)
7. Scheduled crons: daily topic analytics + Q analysis loop

→ **Client routes, services list, Bartlet snap:** `.brv/context-tree/reference/routes-and-services.md`
→ **Snap polls detail (types, storage, dedup):** `.brv/context-tree/reference/snap-polls.md`
→ **Hypersnap phases, CastRouter:** `.brv/context-tree/reference/hypersnap.md`

## Farcaster data providers (`worker/services/farcaster/`)

Every Farcaster **read** goes through `initFarcasterData(env)` (a `FarcasterDataRouter`), never to `api.neynar.com` directly — casting is the separate `services/casting/` CastRouter. Direction (Zoo, 2026-09-07): **full Hypersnap; depend on Haatz for as much as possible before running our own node.** Providers in `FC_DATA_PROVIDER_ORDER` (default `hypersnap,neynar,hub`): `hypersnap` = `NeynarDataProvider` pointed at `<HYPERSNAP_ENDPOINT|HUB_ENDPOINT>/v2/farcaster` (Haatz's Neynar-compatible API, keyless: profiles with follower counts, by-username, address→FID incl. custody, channel search, recency-ranked best friends; ~200 ms); `neynar` = the same class at `api.neynar.com` with `NEYNAR_API_KEY` (the only source for `score`, `pro`, `power_badge`, `viewer_context`, affinity-ranked besties); `hub` = `HubDataProvider` on the bare hub `/v1/*` API (profiles only). `getUsers` fills FIDs in order — later providers answer only what earlier ones missed; pass `need: ['pro']` (or `power_badge`, `score`, `viewer_context`) when you read a Neynar-only field and the router enriches it from Neynar for FIDs Haatz answered (`userAutoCreate` does this for pro status, `users.ts` by-username for the badge). `getFidsByAddresses` is the **union** over every capable provider (holder-gate snapshots want the most complete set). Other capability methods (`searchChannels`, `getBestFriends`, `getUserByUsername`) use the first provider that implements them and fall through on error; `getRelationship(fid, target)` (follow edges, Track C card C10) asks the bare `hub` provider first (`/v1/linkById`, protocol data) whatever the order and falls back to Neynar's `viewer_context`. Allowlist besties and follower checks go through the router (`worker/services/AllowlistGraphHelper.ts`; Haatz's recency-ranked besties accepted). `FarcasterUser` mirrors Neynar's wire shape (`profile.bio.text`, `verified_addresses`, …) so KV profile caches and the client keep working whichever provider answered; `provider` says which did. Neynar-pinned on purpose (they read Neynar-only fields): `NeynarUserService` (score gate + airdrops), `QAgent.getNeynarScore` (uses `QGENT_NEYNAR_API_KEY` via `new NeynarDataProvider({ apiKey })`) — both wait on card C11 (in-house identity cost). Login: `initLoginProvider(env)` (`NeynarLoginProvider`, SIWN client id + authorize URL). Notifications: `initNotificationProvider(env)` (`NeynarNotificationProvider`, formerly `NotificationService`). Adding a provider = implement `FarcasterDataProvider`, register in `initFarcasterData()`. Tests: `test/services/farcasterData.test.ts` (injected fetch).

**Agent writes go to the hub (Track C card C5):** `QAgent.cast/like` and `OracleAgent.dispatch` sign with Ed25519 hub keys (`QGENT_SIGNER_KEY`; council `QLAUDE_SIGNER_KEY` / `QEMINI_SIGNER_KEY` / `CHATQPT_SIGNER_KEY` with FIDs `QLAUDE_FID` / `QEMINI_FID` / `CHATQPT_FID`, Q's key as the fallback while a model's key is unregistered) and submit through `HypersnapService` — no `*_SIGNER_UUID`, no `api.neynar.com` in `worker/agents/`. Replies need the parent's author FID (the hub addresses casts by fid + hash); channel casts carry the channel's `parent_url` (`HypersnapService.getChannel`). `OracleAgent.dispatch` takes `parentHash?` + `parentAuthorFid?` (omit both for a web-only question: nothing is cast) and returns `responses[]` with each model's full text and cast hashes. `FarcasterHubWriter` encodes `ReactionAdd` / `ReactionRemove` (`MessageData.reaction_body = 7`); tests `test/services/hubWriter.test.ts`, `hypersnapService.test.ts`.

**Reactions (Track C card C6):** likes / recasts go through `initReactionRouter(env)` (`worker/services/casting/ReactionRouter.ts`): `HubReactionProvider` (hub signer from `hubSignerLookup` — bot secrets today, user hub signers with card C7) then `NeynarReactionProvider` (grandfathered `user_signers.provider = 'neynar'`). `POST /api/queries/:id/like` uses it (`farcaster_casts.caster_fid` is the target author); 403 `needsSigner` when no provider can react for the FID. Tests: `test/services/reactionRouter.test.ts`.

## Quilibrium

Migration complete. Nillion removed from production code. Quilibrium provides: QStorage for private blobs + static website hosting, QKMS (MPC-powered key mgmt — docs "Coming Soon"), QCL (Q Compute Language for decentralized apps compiled to OT circuits), Klearu (E2EE ML/LLM primitives — Rust library, active dev). `docs/quil/` has architecture docs. QMD indexed for search.

**QStorage static site hosting:** Standard S3 static website config. Each bucket gets a public URL: `https://<bucket-suffix>-<number>.<id>.qstorage.quilibrium.com/`. Works with `aws s3 sync` and `--endpoint-url`. Useful for hosting miniapp frontends without a server.

## Commands

```bash
yarn dev              # Local dev
yarn build            # tsc -b && vite build
yarn deploy           # Build + deploy to Cloudflare Workers
yarn preview          # Build + preview prod locally
yarn lint             # ESLint
yarn test             # Vitest (unit suite — pool runs locally via miniflare)
yarn cf-typegen       # Generate CF binding types
```

## CI + deploy

When the user says "run CI", do **all** of the following in order — CI and deploy ship as one protocol, not two:

1. **CI checks** on the current branch (typically `develop`):
   ```bash
   yarn build  # tsc -b && vite build (typecheck + bundle)
   yarn lint   # ESLint (errors fail; warnings allowed — baseline ~170 warnings)
   yarn test   # 22 tests: 11 PointsService unit + 11 worker fetch-handler
               # integration (via SELF + env from cloudflare:test)
   ```
   Non-zero exit on any is a blocker — stop and surface the failure. Bundle warnings about `vendor-flaunch` (842 KB) and `vendor-farcaster` (605 KB) being above the 500 KB threshold are expected; both are lazy-loaded vendors.
2. Push `develop` to `origin`.
3. Fast-forward `main` to `develop` and push `main` — Cloudflare auto-deploys to prod on every push to `main`.

Local one-shot alternative: `yarn deploy` from project root (build + direct Wrangler deploy, bypasses `main`). Use only when the user explicitly asks for a direct deploy that skips `main`.

## Environment Variables

Config (`wrangler.jsonc`):
- `QGENT_FID` = "975961", `QBASE_FID` = "272012"
- `QSTORAGE_ENDPOINT`, `QSTORAGE_BUCKET` ("qbase"), `QSTORAGE_REGION`
- `QQ_CONTRACT_ADDRESS`, `BARTLET_AIRDROP_ENABLED`
- `BASE_RPC_URL`, `BARTLET_TREASURY_ADDRESS`
- Secrets (not in config; set via `wrangler secret put`):
  - `QSTORAGE_ACCESS_KEY`, `QSTORAGE_SECRET_KEY` — Quilibrium S3 credentials
  - `NEYNAR_API_KEY` — Farcaster API; **server-only**, never bundled to client (see `worker/routes/users.ts` `GET /api/users/by-username/:name`)
  - `HYPERSNAP_WEBHOOK_SECRET` — HMAC-SHA512 for `/webhooks/hypersnap`
  - `QGENT_WEBHOOK_SECRET` — Q agent webhook (mismatch → 401, no longer "log + process anyway")
  - `ANON_SIGNER_KEY`, `QGENT_SIGNER_KEY` — Ed25519 signers for the anon bot (`@4n0n`, FID 514282) and Q agent (FID 975961). **Self-managed**, registered directly on Optimism's `KeyGateway` (not via Neynar). To rotate the anon signer: generate a fresh Ed25519 keypair, run `scripts/register-anon-signer.ts` with the FID's custody wallet to register the public on-chain, then `wrangler secret put ANON_SIGNER_KEY` with the matching private. Wait ~1–2 min for hub propagation before exercising.

`HUB_ENDPOINT` (`vars`, not a secret — currently `https://haatz.quilibrium.com`) is required: `/webhooks/neynar` calls `${HUB}/v1/onChainSignersByFid` to verify the JFS signing key is registered to the claimed FID. Cached in KV (1h positive / 5min negative).

## Docs

- **`docs/STATE.md` is the master record of current state** (live in prod, in flight, next, loose ends, session log). Read it at session start; **update it before ending any session that changed code, schema, deploys, decisions or docs** — edit the rows that changed and append a dated line to `docs/STATE-LOG.md` (full shipping records go to `docs/STATE-SHIPPED.md`, full decision text to `docs/STATE-DECISIONS.md`; STATE.md itself stays short because every session loads it first). It lives only in the main checkout (`docs/` is gitignored); worktrees edit it at that absolute path. A Stop hook (`scripts/hooks/state-record-check.sh`, wired in `.claude/settings.json`) blocks the end of a turn once when tracked source is newer than the file. Plans/specs describe intent; STATE.md describes fact — when they disagree, STATE.md wins.
- **Task state lives on the kanban** (`hermes kanban list`, board `qbase`) — not in markdown. There is no TODO.md; FEATURES.md is a current-state catalog only. Don't add checkbox lists to docs; make cards.
- `docs/` — project documentation (hypersnap, quil, snaps, architecture). **Gitignored — local/private by policy.**
- `docs/plans/` — active plans only. Completed plans get deleted (see lifecycle below). Frozen ideas: `docs/plans/icebox.md`.
- `.brv/context-tree/` — structured knowledge base (reference docs, context)
- QMD search: `qmd search "<query>"` from project root

## Plan Lifecycle

Plans in `docs/plans/` are temporary. When a plan reaches completion:

1. Extract architectural decisions, gotchas, and final-state details into a `.brv/context-tree/reference/` doc (update existing if one covers the area, create new if not).
2. Delete the plan from `docs/plans/`.
3. Reference docs capture the "what and why" in final form. Plans capture intent — they're noise once shipped.

Exception: future/roadmap plans (marked "Future — not now") stay until they become active.

---

*This file is the single source of truth for agent context. Detailed reference docs live in `.brv/context-tree/reference/` and `docs/`.*
