# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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

3. **Nillion SecretVault** - Encrypted private data
   - Private/Allowlist answers (encrypted `user_id` and `value`)
   - Anonymous attribution (encrypted creator IDs)
   - Uses field-level encryption with multi-node replication
   - See `src/lib/nillion/client.ts` and `src/api/answers.ts`

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

**NillionClient** (src/lib/nillion/client.ts):
- Authenticates with Nillion nodes using org key
- Stores and retrieves encrypted data
- Schema-based encryption (plain values sent, SDK handles encryption)

### Important Patterns

**Answer Storage Routing**:
```typescript
// Public answers → D1
// Private/Anon answers → Nillion with encrypted fields
// See src/api/answers.ts for implementation
```

**Vite Configuration**:
- Uses `@vitejs/plugin-react-swc` for fast refresh
- Excludes WASM modules from optimization: `@resvg/resvg-wasm`, `yoga-wasm-web`, `@nillion/nuc`, `@nillion/secretvaults`
- Includes `.wasm` files as assets
- Worker format: ES modules

**Environment Variables** (wrangler.jsonc):
- `QGENT_FID`: Farcaster ID for agent account
- `NILAUTH_URL`: Nillion authentication endpoint
- `NILLION_*`: Encryption and schema configuration
- `QQ_CONTRACT_ADDRESS`: EVM contract address
- Secrets (not in config): `NILLION_ORG_DID`, `NILLION_ORG_KEY`, `NILLION_NODES`

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

- Field-level encryption for private data via Nillion
- Anonymous attribution stored separately from content
- Public data optimized for performance (D1 + KV)
- Private data never cached, never vectorized
- Zero-knowledge architecture: operators cannot decrypt private content

### Development Notes

- Frontend and worker share types via `src/lib/types.ts`
- Worker services can be imported in API handlers
- SPA routing handled by `not_found_handling: "single-page-application"` in wrangler.jsonc
- Dynamic routes (quiz/profile/question) intercept before SPA to inject meta tags
- Development mode provides mock authentication for faster iteration
