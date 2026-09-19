# Security & privacy model

Qbase holds sensitive material: anonymous answers, encrypted private answers, and
Farcaster identities. This document states what the system actually guarantees, so
that a reader can tell a deliberate design decision apart from an oversight.

## Reporting a vulnerability

Use GitHub's private advisory flow on this repository
(**Security → Report a vulnerability**), or email the maintainer. Please do not
open a public issue for anything exploitable. There is no bug bounty and no formal
embargo policy — you will get an acknowledgement and a good-faith fix.

## Trust boundaries

| Tier | At rest | Who can read it |
|---|---|---|
| Public | plaintext in D1 | anyone |
| Anon | plaintext value in D1 under the @4n0n placeholder; the author only as a keyed per-question tag plus a sealed FID in `anon_attributions` | anyone reads the answer; only the worker, holding `ANON_TAG_KEY` and the KEK, can attribute it |
| Secret | AES-256-GCM envelope (`SecretBox`); D1 holds `[encrypted]` + `storage_ref` | the worker, which holds the key — and therefore the operator |
| Allowlist | same as Secret, member-gated | the worker, and any FID on the list |

**Anonymity is sealed to the worker, not to the world.** An anonymous answer's row
and its `answer_meta` shadow carry the @4n0n placeholder, never the author. The
only link to a person is the `anon_attributions` row, which holds a keyed
HMAC tag of `(fid, question)` for lookups and the FID inside a `SecretBox`
envelope for the operator path (migration 0072, `POST /api/admin/anon-seal-migrate`).
Tags are per question, so a database dump can neither attribute an anonymous row
nor cluster one person's anonymous rows. The worker can do both, because it holds
`ANON_TAG_KEY` and the key-encryption key: every tally, dedup and "my anonymous
answer" lookup resolves the person through the tag at request time. Treat the
anon tier as "the operator won't tell, and a leaked database can't", not "the
operator can't know". Anonymous paths no longer write a FID to the worker log;
Cloudflare still sees the authenticated request that carries the answer.

Before 2026-09-19 the row itself stored the author's FID and the attribution
table was a third plaintext copy; the sweep above rewrote every existing row. The
next step is anonymity the operator cannot undo — a proof the server verifies
without learning who answered (World ID nullifiers per wave first, blind-signed
tokens for holder-gated waves later). Until that lands, the guarantee above is the
guarantee.

**"Sealed" means sealed to the worker — not end-to-end.** For Secret and Allowlist
answers the plaintext never reaches storage, but the key-encryption key lives in a
Worker secret, so a compromised Worker, Cloudflare account or operator can decrypt.
Reaching real end-to-end is the reason `SecretBox` reserves a `qkms:` key namespace
for the Quilibrium KMS provider; until that lands, the guarantee above is the
guarantee.

## Known limitations

Live and known, listed rather than quietly present. Each is a design decision under
revision, not a discovery.

1. **Completion ids act as a bearer capability for compatibility compare.**
   `GET /api/values/compare` resolves two completion ids and returns item-level
   answers for the pair. The ids are durable and unrevocable, retaking a quiz does
   not retire an old link, and one participant can publish the pair. The audience
   model does not currently constrain what a compare link discloses. The feature is
   not promoted in production. Hardening — a revocable share/pair token plus an
   audience filter — is in progress; the user-facing copy is corrected with it.
2. **Secret answers are differencable out of the correlation aggregate.** The quiz
   correlation aggregate includes Secret answers, is rebuilt every 8 hours, and the
   personal report carries supporting counts. Those counts are now floored to the
   nearest 5 in the personal report, which hides any single completion's movement;
   the stored aggregate still holds exact values.
3. **The correlation report is not corrected for multiple comparisons.** Roughly
   25k tested cells over ~150 people yield ~1,200 "findings", hundreds of which are
   expected by chance, and they are ranked by effect size — which puts the thinnest
   cells first. The page copy is being changed to stop presenting these as
   established differences.
4. **Rate limiting on the public read endpoints is partial.** Several expensive
   unauthenticated endpoints are unmetered. Treat this as a product under active
   development, not a hardened service.

## Practices

- **Secrets are never committed.** `.dev.vars` is gitignored, `.dev.vars.example`
  is a names-only template, and every production value is bound with
  `wrangler secret put`. Config files carry bindings, never values.
- **Signer registration derives the FID from Neynar's verified signer owner** and
  rejects a caller-supplied FID; a mismatched FID is a 403, not a rebind.
- **An anonymous row and its attribution are written in one D1 batch**, so an
  anonymous answer is never left without its sealed owner, and an Anon quiz row is
  unlinked from its completion (the completion names the person) until it leaves
  Anon.
- **Worker logs carry no FIDs on anonymous paths.** Workers Logs are enabled and
  retained for days; the answer-creation and snap paths log ids and question ids
  only.
- **Sealed-answer key rotation is supported and tested**: per-key `kid`
  namespacing, `SecretBox.rewrap`, and `POST /api/admin/secret-migrate` to sweep
  legacy blobs and rewrapped envelopes.
- **Consent is explicit where it matters.** Eligibility snapshots never ship to the
  wire, Secret and Allowlist answers never enter a question's public aggregate, and
  private payloads are gated on author or allowlist membership before storage is
  consulted.

## Out of scope

- The `$QQ` token and escrow contracts are not in this repository and are not
  covered here.
- Registered third-party services (Cloudflare, Neynar, Quilibrium, OpenRouter) are
  trusted for the data they necessarily handle.
