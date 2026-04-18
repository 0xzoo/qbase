# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Architecture direction**: the Farcaster-as-public-layer rework in [docs/hypersnap/data-layer.md](../docs/hypersnap/data-layer.md) is the current north star. Questions/public answers/likes/follows will move to Farcaster (via Hypersnap); D1 becomes a metadata sidecar; QStorage becomes the E2E-encrypted private lane. The current codebase still reflects the pre-rework shape.

## Commands

### Development
```bash
yarn dev                # Start local dev server with NODE_OPTIONS for WASM support
yarn build              # TypeScript compile + Vite build
yarn preview            # Build and preview production build locally
yarn lint               # Run ESLint
```

### Deployment & Types
```bash
yarn deploy             # Build and deploy to Cloudflare Workers
yarn cf-typegen         # Generate TypeScript types for Cloudflare bindings
```

**Production URL**: https://qbase.tech

### Notes
- Uses Yarn 4.10.3+ as package manager
- Development server requires `NODE_OPTIONS='--no-warnings --experimental-wasm-modules'` for WASM modules
- Cloudflare bindings (D1, KV, Vectorize, etc.) are available in worker context via `env` parameter

## Architecture Overview

### Hybrid Full-Stack Application
Qbase is a React-based Q&A platform deployed on Cloudflare infrastructure with a unique hybrid storage architecture that combines public, private, and encrypted data storage.

**Frontend**: React 19 + TypeScript + Vite + React Router v7
**Backend**: Cloudflare Workers (worker/index.ts)
**Deployment**: Cloudflare Pages with Workers integration

### Storage Architecture (Critical)

The codebase uses **four distinct storage layers** based on data privacy requirements:

1. **D1 Database (SQL)** - Public content and metadata
   - Queries (questions) - always public
   - Public answers
   - User base data, Topics, Quizzes
   - Farcaster integration data

2. **KV Storage** - Edge caching and counters
   - `KV_USER_PROFILES`: User profile data
   - `KV_USER_POINTS`: Points balances and allowances
   - `KV_FRAME_NOTIFICATIONS`: Notification state

3. **QStorage (Quilibrium S3-compatible)** - Private answer blob storage
   - Private/Allowlist answers: JSON blob in a Quilibrium S3 bucket, keyed by answer ID
   - Bucket-level encryption at rest; SigV4 signed PUT/GET from the Worker
   - Worker currently sees plaintext on the write path. Target end-state is client-side encryption before upload (tracked with the Farcaster-data-layer rework in `docs/hypersnap/data-layer.md`); not yet implemented
   - Anonymous attribution is NOT in QStorage — it lives in D1 `anon_attributions`
   - See `worker/services/QStorageService.ts` and `src/api/answers.ts`

4. **Vectorize** - Semantic search
   - `QINDEX`: Question embeddings
   - `AINDEX`: Answer embeddings
   - Used for duplicate detection and similarity matching

**Key Principle**: Data is routed to storage based on audience type (`Public`, `Private`, `Anon`, `Allowlist`). The answer creation flow in `src/api/answers.ts` demonstrates this routing logic.

### Worker Entry Point (worker/index.ts)

The Cloudflare Worker handles:
- Dynamic OG image generation (`/api/og/*`)
- Meta tag injection for social shares (quiz/profile/question routes)
- API endpoints (`/api/*`)
- Vector similarity checks (`/api/check-similarity`)
- AI query parsing (`/api/parse-query`)
- Answer creation with storage routing (`/api/answers`)
- SPA fallback via `env.ASSETS`

### Frontend Architecture

**Authentication**: Dual-mode authentication system
- Web: Farcaster AuthKit (`@farcaster/auth-kit`)
- MiniApp: Farcaster Frame SDK (`@farcaster/miniapp-sdk`)
- Context provider in `src/context/AuthContext.tsx`
- Dev mode provides mock user (fid: 12345, username: 'zoo')

**Routing** (src/App.tsx):
- `/` - Landing page
- `/questions`, `/answers`, `/quizzes` - FeedPage (unified feed component)
- `/question/:id` - Question detail
- `/answer/:answerId` - Answer detail
- `/ask/:username` - Public profile
- `/me` - User control center
- `/qq` - QQ token dashboard
- `/create-quiz` - Quiz creation
- `/admin/tokenomics` - Admin dashboard

### Key Services

**VectorService** (worker/services/VectorService.ts):
- Vectorizes text using CloudFlare AI (`@cf/baai/bge-base-en-v1.5`)
- Checks similarity against existing questions
- Thresholds: `DUPLICATE_THRESHOLD = 0.95`, `SIMILARITY_THRESHOLD = 0.85`
- Retries with exponential backoff on failures

**AIService** (worker/services/AIService.ts):
- Query parsing and analysis

**OGService** (worker/services/OGService.ts):
- Dynamic Open Graph image generation using Satori + resvg-wasm
- Generates images for quizzes, profiles, questions

**MetaService** (worker/services/MetaService.ts):
- Injects meta tags for Farcaster frames/miniapps

**QStorageService** (worker/services/QStorageService.ts):
- Cloudflare Worker–compatible S3 client for Quilibrium's storage layer
- Uses Web Crypto API for SigV4 signing (no AWS SDK dependency)
- Stores private and allowlist answer blobs; D1 holds metadata for queryability
- Key format: `answers/{private|allowlist}/{answerId}`; metadata headers carry `q-id`, `user-id`, `allowlist-id`, etc.

**AnonAttributionService** (worker/services/AnonAttributionService.ts):
- Writes/reads the D1 `anon_attributions` table
- Links anonymous questions and answers back to real user IDs for attribution recovery (server-held; not zero-knowledge)

### Important Patterns

**Answer Storage Routing**:
```typescript
// Public     → D1 Answers (value in plain)
// Anon       → D1 Answers (user_id = anon bot fid) + D1 anon_attributions (real user_id)
// Private    → D1 Answers (value = '[encrypted]' placeholder) + QStorage blob
// Allowlist  → D1 Answers (value = '[encrypted]' placeholder) + QStorage blob (metadata carries allowlist FIDs)
// See src/api/answers.ts for implementation
```

**Vite Configuration**:
- Uses `@vitejs/plugin-react-swc` for fast refresh
- Excludes WASM modules from optimization: `@cf-wasm/resvg`, `@resvg/resvg-wasm`, `yoga-wasm-web`
- Includes `.wasm` files as assets
- Worker format: ES modules

**Environment Variables** (wrangler.jsonc):
- `QGENT_FID`: Farcaster ID for the Q agent account (975961)
- `QSTORAGE_ENDPOINT`, `QSTORAGE_BUCKET`, `QSTORAGE_REGION`: Q Storage connection
- `QQ_CONTRACT_ADDRESS`: EVM contract address
- Secrets (not in config): `QSTORAGE_ACCESS_KEY`, `QSTORAGE_SECRET_KEY`

### Cloudflare Bindings

Available in worker `env` parameter:
- `DB`: D1Database
- `KV_USER_PROFILES`: KVNamespace
- `KV_USER_POINTS`: KVNamespace
- `KV_FRAME_NOTIFICATIONS`: KVNamespace
- `QINDEX`: VectorizeIndex (questions)
- `AINDEX`: VectorizeIndex (answers)
- `AI`: Cloudflare Workers AI
- `R2`: R2Bucket (qbase-images)
- `ASSETS`: Static asset fetcher
- `QGENT`: Durable Object binding (agent system)

### Privacy & Security

- Private/allowlist answers stored as blobs in QStorage, separate from D1 metadata
- Anonymous attribution held in D1 `anon_attributions`, separate from answer content
- Public data optimized for performance (D1 + KV)
- Private data never cached, never vectorized
- Worker currently has plaintext access on the private/allowlist write path. Target end-state is client-side encryption before upload (true E2E, Worker sees ciphertext only); tracked with the Farcaster-data-layer rework — not yet implemented

### Development Notes

- Frontend and worker share types via `src/lib/types.ts`
- Worker services can be imported in API handlers
- SPA routing handled by `not_found_handling: "single-page-application"` in wrangler.jsonc
- Dynamic routes (quiz/profile/question) intercept before SPA to inject meta tags
- Development mode provides mock authentication for faster iteration
