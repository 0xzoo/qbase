# Qbase v2

> **The Personal Context Layer** — Infrastructure for your digital self

Qbase is a decentralized social Q&A platform that enables individuals to build a structured, queryable knowledge base of their opinions, facts, and preferences. By decoupling answers from the moment of asking, Qbase enables a **"write once, answer forever"** paradigm where your responses become a portable, agent-ready identity layer.

## 🎯 The Problem

Personal context is fragmented, locked in corporate silos, and not user-controlled.

When you interact with an AI, the context it learns about you—preferences, background, values—gets stored in their systems. You don't own it. You can't port it elsewhere. If you switch providers, you start from scratch. And if there's a data breach, you have no recourse.

Meanwhile, the richest data about human beliefs and behavior is locked inside platforms like Facebook and Google, used for ad targeting rather than shared for collective understanding.

**For Individuals:**
- No portable identity layer—you fill out forms repeatedly, re-explain yourself to every new AI
- Privacy depends primarily on corporate policy, not architecture
- Your digital self is scattered across platforms you don't control

**For Society:**
- The aggregate picture of human values and beliefs is privatized for profit extraction
- Researchers, journalists, and citizens can't access population-level insights
- Data is used *on* people, not *for* people

## 💡 The Solution

Qbase lets you build a structured, portable, permissioned profile of who you are—once—so humans and AIs can understand you without you repeating yourself or trusting any single platform with everything.

- **Answer once, use everywhere**: Your responses become an API for identity
- **Granular permissions**: Public, private, anonymous, or allowlist—you control who sees what
- **Encrypted & decentralized**: Nillion SecretVault ensures privacy is architectural, not policy-based
- **Open sociology**: Aggregate insights become public goods, not corporate assets

**How We're Building:**

We start with proven human engagement mechanics—viral questions, social quizzes, anonymous hot takes—to build data through natural social interaction. AI utility comes *after* people already have reasons to participate. The result: a protocol where contributing to your own portable identity also contributes to collective understanding.

See [docs/philosophy.md](./docs/philosophy.md) for the deeper vision.

## ✨ Key Features

- **Query System**: Semantic matching prevents duplicate questions and enables query reuse across the platform
- **Multi-Audience Answers**: Public, Private, Anonymous, and Allowlist-based sharing with granular privacy controls
- **Quiz System**: Multi-dimensional assessments with AI-powered generation (Novice Mode) or granular control (Pro Mode)
- **Farcaster Integration**: Native MiniApp support with Quick Auth, social graph integration, and AMA functionality
- **Encrypted Private Storage**: Nillion SecretVault for field-level encryption of sensitive data
- **Vector Search**: Semantic similarity matching for duplicate detection and knowledge graph building
- **Tokenomics**: Dual-layer economy with QP (Query Points) for daily activity and $QQ token for long-term value

See [FEATURES.md](./FEATURES.md) for a complete feature breakdown with stability status and test criteria.

## 🏗️ Architecture

Qbase uses a **hybrid storage architecture** that routes data to appropriate backends based on privacy requirements:

```
┌─────────────────┐
│  React Frontend │
└────────┬────────┘
         │
┌────────▼────────────────────────┐
│   Cloudflare Workers (API)      │
└───┬──────────┬──────────┬────────┘
    │          │          │
┌───▼───┐ ┌────▼────┐ ┌───▼────────┐
│  D1   │ │ Nillion │ │ Vectorize  │
│ (SQL) │ │(Encrypt)│ │ (Embed)    │
└───────┘ └─────────┘ └────────────┘
    │
┌───▼────┐
│   KV   │
│(Cache) │
└────────┘
```

### Storage Strategy

- **D1 (SQL)**: Public content (queries, public answers, users, quizzes)
- **Nillion SecretVault**: Encrypted private data (private answers, anonymous attribution, allowlist answers)
- **KV Storage**: Edge caching (user profiles, QP balances, rate limits)
- **Vectorize**: Semantic search (question/answer embeddings)

See [docs/architecture.md](./docs/architecture.md) for detailed architecture documentation.

## 🚀 Quick Start

### Prerequisites

- Node.js 18+ (with WASM support)
- Yarn 4.10.3+
- Cloudflare account (for D1, KV, Vectorize, Workers)
- Nillion account (for SecretVault)

### Installation

```bash
# Clone the repository
git clone https://github.com/0xZoo/qbase-v2.git
cd qbase-v2

# Install dependencies
yarn install

# Generate Cloudflare types
yarn cf-typegen
```

### Environment Setup

Create a `.dev.vars` file in the project root:

```env
# Nillion Configuration
NILLION_ORG_DID="your_org_did"
NILLION_ORG_KEY="your_org_key"
NILLION_NODES="node1,node2,node3"
NILLION_ANSWER_SCHEMA_ID="your_schema_id"
NILLION_ALLOWLIST_ANSWER_SCHEMA_ID="your_allowlist_schema_id"

# Cloudflare Configuration
D1_DATABASE="your_d1_database"
QINDEX="your_question_vectorize_index"
AINDEX="your_answer_vectorize_index"

# Authentication
HOSTNAME="localhost:5173"
NEYNAR_API_KEY="your_neynar_key"

# Anonymous User Constants
ANON_FID=1234
ANON_FNAME="4n0n"
```

### Development

```bash
# Start development server
yarn dev

# Build for production
yarn build

# Preview production build
yarn preview

# Deploy to Cloudflare
yarn deploy
```

The development server runs on `http://localhost:5173` with hot module replacement.

## 🚢 Deployment

### Multi-Environment Strategy

Qbase uses Cloudflare Workers Builds with two workers for safe updates while users are in production:

| Environment | Purpose | URL | Auto-Deploy |
|------------|---------|-----|-------------|
| **Development** | Feature testing + PR previews | `qbase-v2.z00.workers.dev` | Yes (on push to `develop`) |
| **Production** | Live users | `qbase.tech` | Manual (via version promotion) |

### Quick Deploy Commands

```bash
# Deploy to development (usually automatic via Workers Builds)
wrangler deploy --config wrangler.dev.toml

# Create production version
wrangler versions upload --config wrangler.toml

# Promote version to production
wrangler versions deploy <version-id> --name qbase-v2
```

### Before Beta Launch

**⚠️ IMPORTANT**: Complete the Workers Builds setup before launching beta with production users.

Follow the deployment guide:
- **Full Documentation**: [docs/deployment-strategy-workers-builds-SIMPLE.md](./docs/deployment-strategy-workers-builds-SIMPLE.md) (~30 minutes)

This setup enables:
- ✅ Safe development while users are in production
- ✅ Automated builds via Cloudflare Workers Builds
- ✅ Built-in PR comments and preview URLs
- ✅ Version control for safe production deployments
- ✅ Database migrations with rollback support
- ✅ Environment-specific secrets and configuration

## 📁 Project Structure

```
qbase-v2/
├── src/                    # Frontend React application
│   ├── components/         # Reusable UI components
│   ├── pages/              # Route-level page components
│   ├── context/            # React context providers (Auth)
│   ├── api/                # API client functions
│   ├── lib/                # Utilities and shared logic
│   └── services/           # Service layer
├── worker/                 # Cloudflare Workers backend
│   ├── services/           # Backend services (Auth, Vector, AI, etc.)
│   └── middleware/         # Request middleware (auth, rate limiting)
├── docs/                   # Comprehensive documentation
├── migrations/             # Database migrations
└── public/                 # Static assets
```

## 🔑 Key Concepts

### Queries (Questions)

Queries are the fundamental building blocks. They represent unique questions that can be reused across different contexts. The system uses semantic matching to prevent duplicates and encourage query reuse.

- **Stem**: The core question text (e.g., "What is your favorite programming language?")
- **Type**: Suggested answer format (text, multiple choice, scale)
- **Options**: Suggested choices for MC/scale questions
- **Cost**: 10 QP to create a new query

### Answers

Answers can be stored with different privacy levels:

- **Public**: Stored in D1, visible to everyone
- **Private**: Encrypted in Nillion, only visible to the author
- **Anonymous**: Public answer with hidden author (attribution encrypted in Nillion)
- **Allowlist**: Encrypted in Nillion, visible to curated group members

### Quizzes

Multi-dimensional assessment tools that can measure various traits through structured questions. Two creation modes:

- **Novice Mode**: AI-powered generation from natural language goals
- **Pro Mode**: Granular control over dimensions, questions, and scoring

### Allowlists

Privacy-focused sharing groups supporting:
- Manual lists (up to 100 members)
- Dynamic social graph lists (followers, following, mutuals)
- Besties lists (importable from Farcaster)

## 🔐 Authentication

Qbase supports dual-mode authentication:

- **Farcaster MiniApp**: Quick Auth with JWT tokens (asymmetric verification)
- **Web Context**: Traditional Sign-In with Farcaster (SIWF) with nonce generation

Authentication is implemented but not enforced on all endpoints. See [docs/auth.md](./docs/auth.md) for implementation details.

## 🛠️ Tech Stack

- **Frontend**: React 19, TypeScript, Vite, React Router v7
- **Backend**: Cloudflare Workers, D1 (SQLite), KV, Vectorize
- **Encryption**: Nillion SecretVault (field-level encryption)
- **AI**: Cloudflare Workers AI (`@cf/baai/bge-base-en-v1.5`)
- **Authentication**: Farcaster Quick Auth, AuthKit
- **Social**: Neynar API for Farcaster integration
- **Styling**: CSS (Vanilla), Framer Motion for animations

## 📚 Documentation

Comprehensive documentation is available in the `docs/` directory.

### New to Qbase?

1. Start with **[Philosophy](./docs/philosophy.md)** to understand the vision and hard problems
2. Review **[Architecture](./docs/architecture.md)** to see how components work together
3. Explore **[Queries](./docs/queries.md)** to understand the core data model
4. See **[API Implementation](./docs/api-implementation.md)** for practical examples

### Complete Documentation Index

**Core Concepts:**
- **[Philosophy](./docs/philosophy.md)** - Open sociology, portable identity, and the three actors
- **[Qbase Overview](./docs/Qbase.md)** - Mission and components
- **[Architecture](./docs/architecture.md)** - System design and storage strategy

**Features:**
- **[Queries](./docs/queries.md)** - Query system deep dive
- **[Answers](./docs/answers.md)** - Answer system, privacy tiers, and consent model
- **[Quizzes](./docs/quizzes.md)** - Quiz creation and scoring
- **[Allowlists](./docs/allowlists-feature.md)** - Privacy-focused sharing
- **[Topics](./docs/topics.md)** - Organization and categorization

**Integration:**
- **[Authentication](./docs/auth.md)** - Auth system implementation
- **[Farcaster Integration](./docs/farcaster/farcaster.md)** - MiniApp and social features
- **[Nillion Integration](./docs/nillion/nillion.md)** - Encrypted storage
- **[API Implementation](./docs/api-implementation.md)** - Interface details
- **[Flaunch](./docs/flaunch.md)** - Launch strategy

**Business & Strategy:**
- **[Tokenomics](./docs/tokenomics.md)** - QP and $QQ economy
- **[User Journeys](./docs/user-journeys.md)** - User flows and experiences

## 🧪 Development Notes

### WASM Support

The development server requires WASM module support:

```bash
NODE_OPTIONS='--no-warnings --experimental-wasm-modules' yarn dev
```

This is already configured in the `dev` script in `package.json`.

### Cloudflare Bindings

Cloudflare bindings (D1, KV, Vectorize, etc.) are available in the worker context via the `env` parameter. Use `yarn cf-typegen` to generate TypeScript types.

### Database Migrations

Migrations are stored in `migrations/`. Apply them using Wrangler:

```bash
wrangler d1 migrations apply <database-name>
```

## 🤝 Contributing

When contributing to this project:

1. Understand the architecture and data models before making changes
2. Follow the established patterns for data access (SQL vs Nillion)
3. Use vector search for semantic matching where appropriate
4. Maintain privacy by keeping sensitive data in Nillion
5. Update documentation when adding or changing features

## 📄 License

[Add your license here]

## 🔗 Links

- **Features**: [FEATURES.md](./FEATURES.md)
- **Architecture**: [docs/architecture.md](./docs/architecture.md)
- **Philosophy**: [docs/philosophy.md](./docs/philosophy.md)

## 🙏 Acknowledgments

Built on:
- [Cloudflare Workers](https://workers.cloudflare.com/)
- [Nillion Network](https://www.nillion.com/)
- [Farcaster Protocol](https://farcaster.xyz/)
- [Base Network](https://base.org/)

---

**Qbase** — The infrastructure for your digital self. Write once, answer forever.
