# Qbase — Feature Catalog

> **What this file is**: a current-state catalog of what exists and works, one
> paragraph per feature. **What it is not**: a roadmap or a task list. For the
> operational detail behind any entry here, see `AGENTS.md`.

## Core Q&A

**Query system** — canonical questions with semantic dedup: vectorize-before-create
(no orphaned queries), 0.98 duplicate block / 0.85 similar-suggestion thresholds,
selective embedding (stem-only vs stem+options for template questions, LLM-classified).
Types: text, MC, checkbox, scale, date. Anonymous creation via @4n0n with recoverable
attribution.

**Answer system** — multi-audience storage routing: Public (D1 plain), Anon (D1,
@4n0n-attributed, real author in `anon_attributions`), Secret (D1 placeholder,
content sealed into QStorage under a Worker-held key), Allowlist (sealed the same
way, member-gated reads). See the privacy & trust model in `README.md` for what
each tier actually guarantees. MC/checkbox/scale answers are append-only; latest
per user is canonical everywhere.

**Aggregate result pages** — every question has a public `/question/:id/results`
page; casting the URL embeds a live distribution bar chart in-feed. Counting matches
the snap result scenes; Public/Anon only. See AGENTS.md "Aggregate result pages".

**Polls** — MC questions with optional `closes_at` and onchain-holder eligibility
(NFT or ERC-20 minimum-balance snapshots resolved to FIDs at creation, ~50k holder
cap, 1h per-FID eligibility cache). Legacy questions short-circuit to open.

**Topics** — auto-extracted tags, daily momentum/trending cron (velocity 40% +
growth 30% + engagement 30%), co-occurrence relations, hourly time series.

**Feeds & social** — question/answer/quiz feeds (popular + new), profiles (`/ask/:username`),
follows, question likes via the user's own Farcaster signer (signer-bootstrap flow),
allowlists (manual ≤100, dynamic followers/following/mutuals, besties import).

## Distribution & identity

**Farcaster snaps** — in-feed interactive questions and quizzes with content
negotiation (snap JSON to snap clients, OG-tagged HTML to crawlers), KV-backed
session state machines, append-only answer dedup.

**Snap quizzes** — bartlet (Bartle taxonomy), values (5-dimension), apperception
(cognitive style, $QQ-gated LLM dim narratives), plus browser flow at `/quiz/{slug}`.
Completion airdrops: 4.42M $QQ, Neynar-score-gated, shared 1k-slot cohort, D1-deduped.

**Cast publishing** — CastRouter provider chain (Snapchain primary, Neynar fallback);
text answers cast as replies via queue; anonymous content casts from @4n0n.

**Auth** — Farcaster Quick Auth (miniapp), SIWF (web, single-use nonce), Quilibrium
passkey (WebAuthn + Ed448, PRF-wrapped keys). FID is the Users primary key. Web
signups get a Farcaster account created. Per-IP rate limiting via Durable Object.

**OG images** — dynamic question/quiz/profile/results PNGs (SVG → resvg-wasm,
Albert Sans; known nit: no emoji glyphs).

## Agents & economy

**Q agent** — Durable Object social scientist (@qgent): webhook-driven replies with
prompt-injection sanitization + Neynar-score gating, rate-limited casting, research
program memory.

**$QQ token** — ERC-20 on Base (`/qq` swap UI via Flaunch). Live uses: quiz airdrops,
$QQ-gated premium tiers (apperception/values narratives), and oracle council prepay.
QP points backend exists, UI stripped.

**@4n0n** — anonymous proxy account (FID 514282) with self-managed signer; powers
Anon answers and questions.
