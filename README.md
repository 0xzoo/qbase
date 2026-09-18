# Qbase

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
- **Encrypted & decentralized**: client-side AES-GCM into Quilibrium QStorage — the worker only ever sees ciphertext
- **Open sociology**: Aggregate insights become public goods, not corporate assets

**How We're Building:**

We start with proven human engagement mechanics—viral questions, social quizzes, anonymous hot takes—to build data through natural social interaction. AI utility comes *after* people already have reasons to participate. The result: a protocol where contributing to your own portable identity also contributes to collective understanding.

## ✨ Key Features

- **Query System**: Semantic matching prevents duplicate questions and enables query reuse across the platform
- **Multi-Audience Answers**: Public, Private, Anonymous, and Allowlist-based sharing with granular privacy controls
- **Polls**: Multiple-choice questions with optional `closes_at` deadline and onchain-holder gating (NFT or ERC-20 minimum-balance snapshots resolved to Farcaster FIDs at creation)
- **Quiz System**: Multi-dimensional assessments with AI-powered generation (Novice Mode) or granular control (Pro Mode)
- **Farcaster Integration**: Native MiniApp support with Quick Auth, social graph integration, and AMA functionality
- **Encrypted Private Storage**: Quilibrium QStorage with client-side AES-GCM for Private and Allowlist answers
- **Aggregate Result Pages**: Every question has a shareable `/question/:id/results` page; casting it embeds a live distribution chart in the Farcaster feed
- **Vector Search**: Semantic similarity matching for duplicate detection and knowledge graph building
- **Tokenomics**: Dual-layer economy with QP (Query Points) for daily activity and $QQ token for long-term value

See [FEATURES.md](./FEATURES.md) for the current-state feature catalog.

## 🏗️ Architecture

Qbase uses a **hybrid storage architecture** that routes data to appropriate backends based on privacy requirements:

```
┌─────────────────┐
│  React Frontend │
└────────┬────────┘
         │
┌────────▼────────────────────────────────┐
│   Cloudflare Workers (API)              │
└──┬──────┬─────────┬─────────┬───────────┘
   │      │         │         │
┌──▼──┐ ┌─▼──┐ ┌────▼─────┐ ┌─▼──────────┐
│ D1  │ │ KV │ │QStorage  │ │ Vectorize  │
│(SQL)│ │    │ │(S3+AES)  │ │  (embed)   │
└─────┘ └────┘ └──────────┘ └────────────┘
```

### Storage Strategy

- **D1 (SQL)**: Public content + metadata (queries, public answers, users, quizzes, FC integration)
- **QStorage** (Quilibrium S3): Secret and Allowlist answer payloads — sealed by the worker with AES-256-GCM envelope encryption before they reach storage (see [Privacy & trust model](#-privacy--trust-model))
- **KV**: Edge caching (`KV_USER_PROFILES`, `KV_USER_POINTS`, `KV_FRAME_NOTIFICATIONS`, `BARTLET_SESSIONS`)
- **Vectorize**: Semantic search — `QINDEX` (questions), `AINDEX` (answers)
- **R2**: Bartlet archetype images, avatars

Each tier is described in more detail under [Privacy & trust model](#-privacy--trust-model) and in [FEATURES.md](./FEATURES.md).

## 🚀 Quick Start

### Prerequisites

- Node.js 18+
- Yarn 4.10.3+
- Cloudflare account (D1, KV, R2, Vectorize, Durable Objects, Workers AI)
- A Quilibrium QStorage bucket for encrypted Private/Allowlist blobs
- Neynar account for Farcaster API access

### Installation

```bash
yarn install
yarn cf-typegen   # generate worker-configuration.d.ts from wrangler.jsonc
```

### Environment Setup

Copy `.dev.vars.example` → `.dev.vars` and fill in the values it lists. Bindings (D1 IDs, KV namespaces, R2 buckets, Vectorize indexes, Durable Object class) live in `wrangler.jsonc` (prod) and `wrangler.dev.jsonc` (dev). Production secrets are set with `wrangler secret put`.

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

### Two-environment setup

| Environment | URL | Config |
|---|---|---|
| Development | `qbase-dev.z00.workers.dev` | `wrangler.dev.jsonc` |
| Production | `qbase.tech` | `wrangler.jsonc` |

### Deploy protocol

The CI flow is `yarn build && yarn lint`. Both must exit 0 before pushing.

1. Run CI on `develop` — confirm both pass
2. Push `develop` to `origin`
3. Fast-forward `main` to `develop` and push `main` — Cloudflare auto-deploys to prod on every push to `main`

Local one-shot: `yarn deploy` (build + direct Wrangler deploy, bypasses `main`).

D1 migrations: `yarn migrate:dev` / `yarn migrate:prod`.

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

- **Public**: stored in D1 in plain, visible to everyone
- **Secret** (formerly "Private"): D1 keeps only an `[encrypted]` placeholder — the content is sealed into Quilibrium QStorage under a Worker-held key (see the privacy model below)
- **Anonymous**: stored in D1 with the anon-bot FID; real-author attribution kept in `anon_attributions`
- **Allowlist**: sealed in QStorage the same way as Secret, readable by the allowlist members the author selected

### Polls

A poll is a strict subset of question — MC, public, with optional `closes_at` deadline and/or onchain-holder eligibility gate. Two gate variants share a single `snapshot_fids[]` shape, resolved at poll-creation so the per-vote check is a list lookup:

- **NFT snapshot** (`nft_snapshot`): any holder of a given contract
- **ERC-20 snapshot** (`token_snapshot`): holders of ≥ N tokens (creator types a human amount; we resolve decimals + symbol via viem)

Legacy questions (both fields NULL) short-circuit to open — non-poll behavior is unchanged.

### Quizzes

Multi-dimensional assessment tools that can measure various traits through structured questions. Two creation modes:

- **Novice Mode**: AI-powered generation from natural language goals
- **Pro Mode**: Granular control over dimensions, questions, and scoring

### Allowlists

Privacy-focused sharing groups supporting:
- Manual lists (up to 100 members)
- Dynamic social graph lists (followers, following, mutuals)
- Besties lists (importable from Farcaster)

## 🛡️ Privacy & trust model

The four answer audiences do **not** all provide the same guarantee. Publishing the
code publishes the actual properties, so here they are stated plainly rather than
implied:

- **Public** — plaintext in D1. Anyone can read it.
- **Anonymous** — the answer row is authored by the shared anon-bot FID, and the
  real author is recorded in the `anon_attributions` table in D1. Anonymity here
  is **access control enforced by the worker at read time, not cryptography**:
  API responses never expose the linkage, but whoever operates the database can
  attribute an anonymous answer.
- **Secret / Allowlist** — the value never reaches D1 in plaintext; D1 holds an
  `[encrypted]` placeholder plus a `storage_ref`. The payload is sealed with
  AES-256-GCM envelope encryption (`SecretBox`) under a key-encryption key held
  in the `ANSWER_KEKS` Worker secret, then stored in Quilibrium QStorage.
  The guarantee is **"sealed to Q" — the worker holds the key and decrypts on
  read** — and explicitly *not* end-to-end encryption. It does not protect
  against a compromised Worker or Cloudflare account. (An earlier design
  encrypted client-side; `src/crypto/encrypt.ts` is the unused remnant of that
  path, and `POST /api/admin/secret-migrate` sweeps legacy blobs into the sealed
  format.)
- **Aggregates** — result pages and OG charts only ever include Public and Anon
  answers. Secret and Allowlist answers never enter an aggregate, and the
  per-FID eligibility snapshot list is stripped before a wave is served publicly.

## 🔐 Authentication

Three auth modes, all with single-source-of-truth identity in `src/context/AuthContext.tsx`:

- **Farcaster MiniApp**: Quick Auth with JWT tokens (asymmetric verification, automatic in Warpcast)
- **Web SIWF**: Sign-In with Farcaster via AuthKit; server issues a single-use nonce and exchanges (message, signature, nonce) for a session token
- **Quilibrium Passkey**: native WebAuthn + Ed448 keypair; login challenge-response is verified server-side against the registered public key. The local Ed448 private key is wrapped via the WebAuthn PRF extension on browsers that support it (Chrome/Edge ≥ 132, Safari ≥ 18)

## 🛠️ Tech Stack

- **Frontend**: React 19, TypeScript, Vite + SWC, Tailwind, React Router v7, react-query, framer-motion
- **Backend**: Cloudflare Workers, D1 (SQLite), KV, R2, Vectorize, Durable Objects, Workers AI (`@cf/baai/bge-base-en-v1.5`)
- **Encryption**: AES-256-GCM envelope encryption (`SecretBox`) for the Secret/Allowlist tiers, KEK held in a Worker secret; Ed448 (`@noble/curves`) for passkey identity
- **Authentication**: Farcaster Quick Auth, Farcaster AuthKit (SIWF), native WebAuthn for passkey
- **Farcaster integration**: Neynar API + Farcaster Hub (`HUB_ENDPOINT`) for signer attestation

## 📚 Documentation

- **[FEATURES.md](./FEATURES.md)** — current-state feature catalog of what exists

## 📝 How this was built

Qbase is built in close collaboration with AI coding agents, working from a
maintained operational context document that covers storage routing, the route
hierarchy and the deploy protocol. Product direction, architecture decisions and
review are human; a substantial share of the implementation is agent-assisted.
That operational document is deliberately not published here.

## 🧪 Development

CI is `yarn build && yarn lint && yarn test` (lint errors fail; warnings allowed). Run all three locally before pushing. `yarn test` runs the vitest suite — 33 files / 326 tests covering unit services plus worker fetch-handler integration wired through `cloudflare:test`. The suite needs no secrets: it runs entirely against local bindings.

When changing auth or privacy paths, walk through the manual auth and privacy checks before promoting `develop` → `main`.

## 📌 About this repository

This repository is published so the work can be read and reviewed. Qbase runs in
production at [qbase.tech](https://qbase.tech) and the source is complete and
maintained, but the project is not currently open to external contributions.

## 🙏 Acknowledgments

Built on:
- [Cloudflare Workers](https://workers.cloudflare.com/)
- [Quilibrium](https://www.quilibrium.com/) (QStorage, Ed448)
- [Farcaster Protocol](https://farcaster.xyz/)
- [Base Network](https://base.org/)

---

**Qbase** — The infrastructure for your digital self. Write once, answer forever.
