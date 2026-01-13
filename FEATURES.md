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
  - Anonymous query support with recoverable attribution via Nillion
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
- **Description**: Multi-audience answer storage with routing to appropriate storage layer (D1, Nillion, KV)
- **Properties**:
  - Four audience types: Public, Private, Anonymous, Allowlist
  - Public answers stored in D1 (SQL)
  - Private/Allowlist answers encrypted in Nillion SecretVault
  - Anonymous attribution stored in Nillion with recoverable link
  - Answer types: text, multiple choice (select one), checkbox (select many), scale (flexible per query)
  - All answer values stored as structured JSON strings
  - Integer-based `answer_type_id` with lookup table for extensibility
  - **Current Phase**: Users create permanent saved answers (no temporary state)
  - **Save to Qbase**: Currently integrated into answer creation flow
- **Test Criteria**:
  - [x] Public answers stored in D1
  - [x] Private answers encrypted in Nillion
  - [x] Allowlist answers accessible only to list members
  - [x] Anonymous answers hide author publicly
  - [x] Recoverable attribution link stored in Nillion
  - [ ] Answer retrieval respects privacy settings

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

### Nillion Private Storage
- **Stability**: stable
- **Description**: Encrypted private data storage using Nillion SecretVault for sensitive answers and anonymous attribution
- **Properties**:
  - Field-level encryption with multi-node replication
  - Private answers encrypted with user_id and value
  - Anonymous attribution links stored as HiddenLink records
  - Collection-based organization (answer schemas, attribution collection)
  - Recoverable attribution enables moderation and claiming
- **Test Criteria**:
  - [x] Private answers encrypted and stored in Nillion
  - [x] Anonymous attribution links stored securely
  - [x] Encrypted data retrievable by authorized users
  - [x] Field-level encryption working correctly
  - [ ] Multi-node replication verified

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
  - Daily QP allowance: ~100 QP base + tiered status bonus
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

### Anonymous Bot Account with Attribution (@4n0n)
- **Stability**: stable
- **Description**: Anonymous content posting system using dedicated bot account (@4n0n, FID 514282) with encrypted attribution via Nillion
- **Properties**:
  - Anonymous queries and answers posted from @4n0n bot account to Farcaster
  - Real authorship encrypted as HiddenLink records in Nillion SecretVault
  - Separate Neynar API key and signer for anon bot (rate limit isolation)
  - Backend auto-casts anonymous queries from bot account
  - Frontend casts anonymous answers via `useAnonBot` flag
  - Attribution enables claiming viral content and governance/moderation
  - Public sees content from @4n0n, no link to real author
  - Users can prove ownership to claim anonymous content later
- **Test Criteria**:
  - [x] Anonymous queries display as from @4n0n
  - [x] Anonymous answers display as from @4n0n
  - [x] HiddenLink attribution encrypted in Nillion
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
  - **Separate table**: `temporary_answers` in D1 (no Nillion, no privacy tiers)
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

