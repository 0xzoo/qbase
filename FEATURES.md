# Qbase - Features

> **⚠️ Pre-Beta Requirement**: Before launching beta with production users, complete the deployment strategy outlined in [deployment-strategy-workers-builds-SIMPLE.md](./docs/deployment-strategy-workers-builds-SIMPLE.md). This enables safe development with separate dev/production environments using Cloudflare Workers Builds.

## Features

### Farcaster Authentication
- **Stability**: stable
- **Description**: Dual-mode authentication system supporting both Farcaster MiniApp (Quick Auth) and web contexts (SIWF)
- **Properties**:
  - Quick Auth JWT tokens verified asymmetrically (no network calls)
  - Automatic context detection (MiniApp vs web)
  - Token stored in React state (MiniApp) or localStorage (web)
  - Domain validation via HOSTNAME environment variable with automatic preview URL support (see [deployment-strategy-workers-builds-SIMPLE.md](./docs/deployment-strategy-workers-builds-SIMPLE.md) for details)
  - Rate limiting: 20 req/min reads, 10 req/min writes (production settings; can be adjusted per environment)
  - **Preview URL Support**: Auth automatically uses request hostname for `.workers.dev` domains, enabling preview branches to work without config changes
- **Test Criteria**:
  - [x] Quick Auth token generation in MiniApp context
  - [x] JWT verification succeeds with valid token
  - [x] Authentication fails with invalid/missing token
  - [x] Context detection correctly identifies MiniApp vs web
  - [x] Rate limiting blocks excessive requests

### Query System (Questions)
- **Stability**: stable
- **Description**: Core Q&A system with semantic matching to prevent duplicate questions and enable query reuse
- **Properties**:
  - Semantic similarity matching using vector embeddings (threshold: 0.85+)
  - **Duplicate prevention**: Vector generation and similarity check happen BEFORE query creation
  - **No queries without vectors**: If vectorization fails, returns 503 (query not created)
  - Multiple question types: text, multiple choice (select one), checkbox (select many), scale
  - Template question support (LLM-based incomplete stem detection)
  - Vector embeddings stored in Cloudflare Vectorize (QINDEX)
  - QP cost: 10 QP to create a new query
  - Anonymous query support with recoverable attribution via D1 `anon_attributions` table
- **Test Criteria**:
  - [x] Query creation stores in D1 database
  - [x] Vector embedding generated and stored in Vectorize
  - [x] Semantic matching finds similar queries
  - [x] Duplicate detection prevents near-identical questions (0.98 threshold)
  - [x] Duplicate check happens BEFORE query creation
  - [x] Query creation fails if vectorization fails (no orphaned queries)
  - [x] QP deduction on query creation
  - [x] Template questions handled correctly (see [template-questions.md](./docs/template-questions.md)) ✅
    - [x] **LLM classification** detects incomplete stems (Cloudflare AI llama-3-8b-instruct) ✅
    - [x] Incomplete stem creation rejected with clear error ✅
    - [x] Questions with incomplete stems require options (min 2) ✅
    - [x] **Selective embedding strategy**: Include options only for incomplete stems ✅
    - [x] Regular MC questions: stem-only embeddings (options can vary) ✅
    - [x] Template questions: stem+options embeddings (options are part of identity) ✅
    - [x] **Two-threshold system** for different use cases ✅
      - [x] Recommendation threshold (0.85): Show similar questions
      - [x] Duplicate threshold (0.98): Block near-identical questions
    - [x] Context-aware classification (fast colon heuristic + LLM) ✅
    - [x] Error handling: LLM failures propagate to user (no silent degradation) ✅
    - [ ] Incomplete stems rejected for NFT minting (awaiting NFT implementation)
    - [ ] Complete questions (with or without options) can be minted (awaiting NFT implementation)
    - [x] **Implementation completed in worker services and API** ✅

### Answer System
- **Stability**: stable
- **Description**: Multi-audience answer storage with routing to appropriate storage layer (D1, QStorage, KV)
- **Properties**:
  - Four audience types: Public, Secret (formerly "Private"), Anonymous, Allowlist
  - Public answers stored in D1 (SQL) in plain
  - Secret/Allowlist answers client-side AES-GCM encrypted into Quilibrium QStorage (S3-compatible); D1 only stores a `[encrypted]` placeholder
  - Anonymous answers stored in D1 with the @4n0n bot FID; real-author attribution kept in D1 `anon_attributions` (recoverable for claiming/moderation)
  - Answer types: text, multiple choice (select one), checkbox (select many), scale, date (flexible per query)
  - All answer values stored as structured JSON strings
  - Integer-based `answer_type_id` with lookup table for extensibility
  - **Current Phase**: Users create permanent saved answers (no temporary state)
  - **Save to Qbase**: Currently integrated into answer creation flow
- **Test Criteria**:
  - [x] Public answers stored in D1
  - [x] Secret answers client-side encrypted into QStorage (worker only sees ciphertext)
  - [x] Allowlist answers accessible only to list members
  - [x] Anonymous answers hide author publicly
  - [x] Recoverable attribution stored in D1 `anon_attributions`
  - [ ] Answer retrieval respects privacy settings

### Polls (time-bound + onchain-holder gating)
- **Stability**: stable
- **Description**: A poll is a strict subset of question — MC, public, with optional `closes_at` deadline and/or onchain-holder eligibility gate. Non-poll questions are unaffected (both fields NULL → short-circuit to open).
- **Properties**:
  - Schema: `queries.closes_at` (nullable ISO TEXT) + `queries.eligibility_gate` (nullable JSON TEXT) — migration `0057_add_poll_fields.sql`
  - Gate is a discriminated union on `type`: `nft_snapshot` (any holder) and `token_snapshot` (≥ N of an ERC-20)
  - Both gates resolve at poll-creation to a `snapshot_fids[]` list stored inline on the gate JSON — per-vote check is a list lookup
  - NFT snapshot: Alchemy `getOwnersForContract` (paginated, 50k cap) → Neynar `bulk-by-address` (350-batch) → FIDs
  - Token snapshot: viem `readContract` for `decimals()` + `symbol()`, Alchemy `getOwnersForContract?withTokenBalances=true` (100k rows scanned), filter `BigInt(balance) >= min_balance_wei`, then Neynar resolve
  - Creator types human-readable amount (e.g. "4420000"); we store both `min_balance` and `min_balance_wei`
  - Lock banner copy: "Hold ≥ N $SYMBOL to vote" when `symbol()` succeeds, falls back to short address
  - `EligibilityService.check` reasons: `no_gate | open | closed | not_holder | unknown_gate`; per-FID cached 1h in `KV_USER_PROFILES`
  - Wired into 3 call sites: `worker/handlers/answers/create.ts` (423/403), `worker/routes/snap.ts` GET+POST (locked results scene with reason), `GET /api/queries/:id/eligibility?fid=` (client probe)
  - `snapshot_fids` is **stripped before `GET /api/queries/:id`** — never shipped to the wire (would bloat 50k-FID polls)
  - Client lock UX: `useEligibility` hook + `PollLockBanner` above a disabled `QuestionRenderer`; fail-open on probe error
  - Admin debug: `GET /api/admin/eligibility?qid=&fid=` to inspect snapshot membership
- **Known limits**:
  - Synchronous snapshot inside a CF Worker request hits a ~30s wall-clock ceiling; oversized collections rejected with clear error
  - Async/durable-object snapshotting is a v1 problem
  - Alchemy ERC-20 holder coverage via the NFT API isn't guaranteed per token — confirm with `/api/admin/eligibility` dry run before launching any new gated poll; fallback would be Etherscan v2 `tokenholderlist` or Transfer-event replay
- **Test Criteria**:
  - [x] Legacy questions (closes_at + gate both NULL) behave unchanged
  - [x] NFT snapshot pipeline resolves holders → FIDs at creation
  - [x] Token snapshot pipeline filters by min_balance before Neynar resolve
  - [x] Vote rejected with 423 (closed) / 403 (not_holder) at create-answer
  - [x] Snap GET/POST renders locked results scene with reason
  - [x] `snapshot_fids` stripped from public query GET
  - [ ] Bartlet poll launch — Alchemy $QQ coverage confirmed via debug route
  - [ ] >50k holder rejection surfaces clear creator-facing error
  - [ ] Async snapshotting (durable-object) — v1

### Aggregate Result Pages
- **Stability**: stable
- **Description**: Public, shareable distribution page per question — the castable "finding" artifact of the question-cadence loop
- **Properties**:
  - SPA page at `/question/:id/results` (animated bars, answer/cast/copy actions)
  - `GET /api/queries/:id/aggregate` — unified distribution (MC, checkbox, scale histogram; text → count + recent answers), latest-answer-per-user semantics matching snap result scenes
  - Public/Anon answers only — Secret/Allowlist never counted in aggregates
  - `GET /api/og/results/:id` — 1200×630 bar-chart PNG; casting the results URL embeds the live chart in-feed via `fc:miniapp` meta injection
  - Caching: 60s on data, 5min on chart
- **Test Criteria**:
  - [x] MC counts match snap results scene (latest per user, Anon included)
  - [x] Append-only re-answers counted once (latest wins)
  - [x] OG chart renders winner-highlighted bars; text questions get count fallback
  - [x] fc:miniapp embed resolves on /question/:id/results
  - [ ] Emoji in stems render in OG output (currently tofu — no emoji font in resvg)

### Quiz System
- **Stability**: in-progress
- **Description**: Multi-dimensional assessment tools with two creation modes (Novice/Architect and Pro/Studio)
- **Properties**:
  - Novice Mode: AI-powered quiz generation from natural language goals
  - Pro Mode: Granular control over dimensions, questions, and scoring
  - Dimension-based scoring with custom measurement axes
  - Query integration: questions link to canonical Query system
  - Preset options library (Likert scales, frequency, importance, etc.)
  - All question types supported: text, multiple choice, checkbox, scale
  - Cost: 50 QP base + 5 QP per new query needed
  - Unlock cost: 20 QP to view quiz report
- **Test Criteria**:
  - [x] Quiz creation stores in D1
  - [x] Questions link to Query system
  - [x] Dimension weights applied to scoring
  - [ ] Architect agent generates complete quiz drafts
  - [ ] Preset options library accessible
  - [ ] Quiz report generation and unlocking

### Allowlist Privacy System
- **Stability**: stable
- **Description**: Privacy-focused answer sharing with curated groups, supporting manual lists and dynamic social graph lists
- **Properties**:
  - Manual lists: up to 100 members, fully editable
  - Dynamic lists: My Followers, My Following, Mutual Followers (unlimited, real-time checks)
  - Besties lists: up to 50 members, importable from Neynar
  - Real-time membership verification via Neynar API
  - Aggressive caching: 5-10 minutes for performance
  - FID to internal user ID translation for multi-platform support
- **Test Criteria**:
  - [x] Manual allowlist creation and management
  - [x] Dynamic list membership checked via Neynar API
  - [x] Besties import from Farcaster
  - [x] Access control enforces allowlist membership
  - [x] Caching reduces API calls
  - [ ] Access revoked immediately when relationships change

### Vector Search & Semantic Matching
- **Stability**: stable
- **Description**: Semantic similarity search using Cloudflare Vectorize for duplicate detection and query matching
- **Properties**:
  - Embeddings generated using `@cf/baai/bge-base-en-v1.5`
  - Duplicate threshold: 0.98 (block near-identical questions)
  - Similarity threshold: 0.85 (recommendations and related questions)
  - Selective embedding strategy: stem-only OR stem+options based on LLM classification
  - Separate indices: QINDEX (questions), AINDEX (answers)
  - Retry logic with exponential backoff
- **Test Criteria**:
  - [x] Vector embeddings generated for queries
  - [x] Similarity search finds related queries
  - [x] Duplicate detection prevents near-identical questions
  - [x] Retry logic handles transient failures
  - [x] Answer embeddings stored for Public and Anon answers (searchable via AINDEX)

### Quilibrium QStorage (Encrypted Private/Allowlist Blobs)
- **Stability**: stable
- **Description**: Client-side AES-GCM encryption into Quilibrium QStorage (S3-compatible) for Secret and Allowlist answers. The worker only ever sees ciphertext — the encryption key never leaves the client.
- **Properties**:
  - Client-side AES-GCM encrypt before upload; worker stores/serves opaque ciphertext only
  - QStorage accessed server-only through `QStorageService.fromEnv(env)` — no `/api/qstorage/*` HTTP proxy (closed an unauth blob-read/write hole)
  - D1 stores a `[encrypted]` placeholder + the QStorage object ref so listings/counts work without decryption
  - Read gates enforced server-side: Secret reads gated on author identity, Allowlist reads gated on allowlist membership *before* consulting QStorage
  - `GET /api/users/:fid/answers` refuses to leak Secret payloads or `is_own_anon` flags to anyone but the responder themselves
  - Anonymous attribution lives in D1 `anon_attributions` (not QStorage) — recoverable link for claiming and moderation
- **Test Criteria**:
  - [x] Secret answers client-side encrypted before upload
  - [x] Worker never decrypts (only ciphertext on the wire and at rest)
  - [x] Allowlist read gated on membership before QStorage fetch
  - [x] `/api/qstorage/*` proxy removed — no unauth blob access
  - [x] Anonymous attribution stored in D1 `anon_attributions`

### Farcaster MiniApp Integration
- **Stability**: in-progress
- **Description**: Native Farcaster MiniApp support with Quick Auth, notifications, and social graph integration
- **Properties**:
  - Quick Auth token generation via SDK
  - Back navigation enabled for web navigation sync
  - Notification support (enabled/disabled events)
  - Social graph data via Neynar API
  - AMA (Ask Me Anything) miniapp for direct queries
- **Test Criteria**:
  - [x] Quick Auth integration working
  - [x] MiniApp context detection
  - [x] Back navigation syncs with React Router
  - [ ] Notification events handled correctly
  - [ ] AMA miniapp renders in Farcaster clients

### Direct Queries
- **Stability**: planned
- **Description**: User-to-user direct questioning with payment system ($QQ tokens)
- **Properties**:
  - Social direct queries: 10 QP cost
  - Expert direct queries: $QQ token payment
  - Recipient can accept, decline, or counter-offer
  - Payment completes only when answer provided
  - Custom pricing based on expertise/reputation
- **Test Criteria**:
  - [ ] Direct query creation and sending
  - [ ] Payment escrow system
  - [ ] Accept/decline/counter-offer flow
  - [ ] Payment release on answer completion
  - [ ] Custom pricing configuration

### User Profiles & Control Center
- **Stability**: in-progress
- **Description**: User profile pages and personal control center for managing Qbase activity
- **Properties**:
  - Public profile pages (`/ask/:username`)
  - Control center (`/me`) for personal dashboard
  - Profile data stored in KV (KV_USER_PROFILES)
  - Answer history and highlights
  - QP balance and tokenomics dashboard
- **Test Criteria**:
  - [x] Public profile pages render correctly
  - [x] Control center accessible to authenticated users
  - [x] Profile data retrieved from KV
  - [ ] Answer history displayed
  - [ ] QP balance shown accurately

### Tokenomics System (QP & $QQ)
- **Stability**: planned
- **Description**: Dual-layer economy with QP (Query Points) for daily activity and $QQ token for long-term value
- **Properties**:
  - Daily QP allowance: ~20 QP base + tiered status bonus
  - Earned QP: durable balance from quiz unlocks and rewards
  - $QQ token: ERC-20 on Base for enterprise access
  - Status tiers: Member (0 $QQ), Pro (~$100 LP), Whale (~$1,000 LP)
  - QP to $QQ conversion via monthly reward pool
  - Treasury system for sustainability
- **Test Criteria**:
  - [ ] Daily QP allowance refills at UTC 00:00
  - [ ] QP balance stored in KV_USER_POINTS
  - [ ] Status tier calculation based on LP
  - [ ] QP deduction on actions (ask question, create quiz)
  - [ ] Monthly settlement for earned QP conversion

### OG Image Generation
- **Stability**: stable
- **Description**: Dynamic Open Graph image generation for social sharing of quizzes, profiles, and questions
- **Properties**:
  - Route-based OG image generation (`/api/og/*`)
  - Meta tag injection for dynamic routes
  - Supports quiz, profile, and question routes
  - Cloudflare Workers AI for image generation
  - In-feed preview strategy for social platforms
- **Test Criteria**:
  - [x] OG images generated for quiz routes
  - [x] OG images generated for profile routes
  - [x] OG images generated for question routes
  - [x] Meta tags injected correctly
  - [ ] Images render correctly in social platforms
  - [ ] Embed images created for all shareable pages (questions, answers, quizzes, profiles, feeds)
  - [ ] In-feed display strategy designed and documented
  - [ ] OG images optimized for Twitter/X, Farcaster, Discord, Insta and Telegram

### Rate Limiting
- **Stability**: stable
- **Description**: IP-based rate limiting for API endpoints to prevent abuse
- **Properties**:
  - KV-based tracking with automatic expiration
  - Limits: 20 req/min for reads, 10 req/min for writes
  - Applied before authentication check
  - Per-endpoint configuration support
- **Test Criteria**:
  - [x] Rate limiting blocks excessive requests
  - [x] KV-based tracking works correctly
  - [x] Automatic expiration resets limits
  - [x] Different limits for read vs write operations

### Feed System
- **Stability**: in-progress
- **Description**: Unified feed component displaying questions, answers, and quizzes with filtering
- **Properties**:
  - Multiple feed types: questions, answers, quizzes
  - Popular and new feed views
  - Pagination support
  - Filtering and search capabilities
- **Test Criteria**:
  - [x] Feed pages render correctly
  - [x] Multiple feed types accessible
  - [ ] Pagination works correctly
  - [ ] Search and filtering functional
  - [ ] Popular feed algorithm accurate

### Topic Search & Trending
- **Stability**: stable
- **Description**: Topic-based organization and discovery for questions with trending analytics
- **Properties**:
  - Topics automatically extracted from question tags (format: `source:topic`)
  - Trending algorithm: Momentum = (Velocity × 40%) + (Growth × 30%) + (Engagement × 30%)
  - Status indicators: 🔥 Hot (momentum > 70), 📈 Rising, 📊 Steady, 💤 Quiet
  - Related topics via co-occurrence tracking
  - Time series data for activity charts
  - Daily cron job for metrics updates (midnight UTC)
  - Topic tags displayed on question cards
- **Routes**:
  - `/topics` - Browse all topics with search and filters
  - `/topics/:name` - Topic detail page with questions
- **API Endpoints**:
  - `GET /api/topics` - List topics with metrics
  - `GET /api/topics/trending` - Trending topics
  - `GET /api/topics/search?q=...` - Autocomplete search
  - `GET /api/topics/:id` - Single topic details
  - `GET /api/topics/:id/related` - Related topics
  - `GET /api/topics/:id/timeseries` - Chart data
  - `GET /api/queries/:id/topics` - Topics for a query
- **Test Criteria**:
  - [x] Topics stored when questions created
  - [x] Topic search and autocomplete working
  - [x] Trending topics calculated correctly
  - [x] Topic tags displayed on questions
  - [x] Topics page renders with filters
  - [x] Topic detail page shows questions
  - [ ] Backfill script run for existing questions
  - [ ] Cron job verified in production

### Anonymous Bot Account with Attribution (@4n0n)
- **Stability**: stable
- **Description**: Anonymous content posting system using dedicated bot account (@4n0n, FID 514282) with recoverable attribution stored in D1
- **Properties**:
  - Anonymous queries and answers posted from @4n0n bot account to Farcaster
  - Real authorship stored in D1 `anon_attributions` table (recoverable link for claiming and moderation)
  - Separate Neynar API key and signer for anon bot (rate limit isolation)
  - Backend auto-casts anonymous queries from bot account
  - Frontend casts anonymous answers via `useAnonBot` flag
  - Attribution enables claiming viral content and governance/moderation
  - Public sees content from @4n0n, no link to real author
  - Users can prove ownership to claim anonymous content later
- **Test Criteria**:
  - [x] Anonymous queries display as from @4n0n
  - [x] Anonymous answers display as from @4n0n
  - [x] Attribution stored in D1 `anon_attributions`
  - [x] Separate API key and signer configured for anon bot
  - [x] Backend auto-casts anonymous queries
  - [x] Frontend casts anonymous answers using anon bot
  - [x] AnonAttributionService methods implemented
  - [x] Real author IDs encrypted in attribution records
  - [ ] Claiming mechanism UI implemented
  - [ ] "My Anonymous Posts" page accessible
  - [ ] Governance features (strikes, shadowban, appeals) implemented

### AI Services
- **Stability**: in-progress
- **Description**: AI-powered features including query parsing, quiz generation, and answer analysis
- **Properties**:
  - Query parsing endpoint (`/api/parse-query`)
  - Architect agent for quiz generation
  - Cloudflare Workers AI integration
  - Text answer analysis for scoring
- **Test Criteria**:
  - [x] AI service initialized correctly
  - [ ] Query parsing extracts intent
  - [ ] Architect agent generates quiz drafts
  - [ ] Text answer analysis for dimension scoring
  - [ ] Error handling for AI failures

### CI/CD & Multi-Environment Deployment
- **Stability**: planned (REQUIRED before beta)
- **Description**: Two-worker deployment strategy (dev/production) with Cloudflare Workers Builds for safe updates while users are in production
- **Properties**:
  - Two separate Workers with isolated resources (qbase-v2-dev, qbase-v2)
  - Environment-specific configuration (HOSTNAME, rate limits, API keys)
  - Automated builds via Workers Builds: develop → dev (auto-deploy), main → prod (versions-only)
  - Built-in PR comments and preview URLs for all branches
  - Version control system for safe production deployments (manual promotion)
  - Database migration strategy with backups and rollback procedures
  - Health check endpoints per environment
  - Complete documentation in [deployment-strategy-workers-builds-SIMPLE.md](./docs/deployment-strategy-workers-builds-SIMPLE.md)
- **Test Criteria**:
  - [ ] Development resources created (D1, KV, R2, Vectorize)
  - [ ] Separate wrangler configs created (wrangler.dev.toml, wrangler.toml)
  - [ ] HOSTNAME configured correctly per environment (dev/prod)
  - [ ] qbase-v2-dev Worker connected to repository (develop branch)
  - [ ] qbase-v2 Worker connected to repository (main branch, versions-only)
  - [ ] Non-production branch builds enabled for dev (PR comments + previews)
  - [ ] Workers Builds configured with correct build/deploy commands
  - [ ] Secrets set for both workers
  - [ ] Database migrations tested in dev → prod order
  - [ ] Deployment to dev auto-triggers on push to develop branch
  - [ ] Push to main creates version (not deployed) for production
  - [ ] Manual version promotion tested
  - [ ] Branch protection rules enabled for main branch

---

## Planned Features (Phase 4+)

### Temporary Answers System
- **Stability**: planned
- **Description**: Lightweight survey response system enabling zero-friction tourist participation before committing to saved answers
- **Properties**:
  - **Separate table**: `temporary_answers` in D1 (no encryption, no privacy tiers)
  - Free to answer (0 QP cost)
  - 30-day storage window
  - Hidden from public feeds (only visible to survey creator and author)
  - Tourist-friendly (no account required initially)
  - Session/device tracking for answer claiming
  - **Save to Qbase**: 2 QP to migrate to permanent `answers` table with privacy choice
  - **Prepaid saves**: Survey creators can auto-save respondent answers
  - Privacy tier chosen at save time, not answer time
- **Test Criteria**:
  - [ ] Temporary answers stored in separate D1 table
  - [ ] Temporary answers hidden from public query feeds
  - [ ] 30-day expiration and cleanup job
  - [ ] Session-based tracking for unauthenticated users
  - [ ] Save endpoint migrates temp → saved with privacy choice
  - [ ] 2 QP transferred to question creator on save
  - [ ] Prepaid save mechanism for survey creators
  - [ ] Temporary answers excluded from AI agent queries
  - [ ] Temporary answers excluded from profile exports

### Question Creator Economy
- **Stability**: planned
- **Description**: Revenue sharing system rewarding quality question creation (enabled by temporary → saved flow)
- **Properties**:
  - 2 QP earned per saved answer to creator's question
  - Real-time earnings tracking and display
  - Leaderboards for top-earning questions
  - Creator analytics dashboard
  - Anti-gaming detection and moderation
  - Monthly settlement windows for abuse detection
- **Test Criteria**:
  - [ ] QP transfer to question creator on save
  - [ ] Earnings displayed on question pages
  - [ ] Creator dashboard shows total earnings
  - [ ] Leaderboard tracks top questions by saves
  - [ ] Gaming detection flags suspicious patterns
  - [ ] Monthly review window before earnings claimable
  - [ ] Ban system prevents payout to bad actors

### Pretext Text Measurement A/B Test
- **Stability**: ready-to-test
- **Description**: A/B test Pretext-powered AnswerCard vs original DOM-based rendering for text measurement accuracy and performance
- **Properties**:
  - `AnswerCardPretext.tsx` built — drop-in replacement with identical props
  - `useTextMeasure` hook provides reflow-free text measurement via @chenglou/pretext
  - Accurate line-based truncation with "Show more/less" (no CSS line-clamp)
  - Pure arithmetic layout — no getBoundingClientRect or offsetHeight
  - Package installed: `@chenglou/pretext`
  - Font constants: 400 16px Inter, 24px line-height (synced with .answer-content CSS)
- **To wire in**: Swap import in `AnswerList.tsx` from `AnswerCard` to `AnswerCardPretext`
- **Test Criteria**:
  - [ ] AnswerCardPretext renders identically to AnswerCard for short text
  - [ ] Long answers show accurate "Show more (N lines)" toggle
  - [ ] Truncation ellipsis lands at correct character boundary
  - [ ] Performance: measure render time for 50+ answer cards (expect improvement)
  - [ ] Mobile: verify container width measurement via ResizeObserver
  - [ ] Mixed content: emoji, RTL text, CJK characters render correctly
  - [ ] A/B comparison: deploy both side by side on dev

### Privy Authentication Integration
- **Stability**: planned
- **Description**: Email/phone authentication for broader accessibility and answer claiming
- **Properties**:
  - Email and phone number authentication
  - Social login support (Google, Apple, etc.)
  - Session-based answer tracking for unauthenticated users
  - Answer claiming via email/phone verification
  - Gradual onboarding from tourist to full user
- **Test Criteria**:
  - [ ] Email authentication working
  - [ ] Phone authentication working
  - [ ] Social login integration
  - [ ] Unauthenticated answers linked to session
  - [ ] Email/phone verification claims previous answers
  - [ ] Seamless upgrade from tourist to authenticated user
  - [ ] Integration with existing Farcaster auth system

