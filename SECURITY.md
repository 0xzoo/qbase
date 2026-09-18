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
| Anon | plaintext value in D1; real author in `anon_attributions` | anyone reads the answer; the author linkage is server-side access control |
| Secret | AES-256-GCM envelope (`SecretBox`); D1 holds `[encrypted]` + `storage_ref` | the worker, which holds the key — and therefore the operator |
| Allowlist | same as Secret, member-gated | the worker, and any FID on the list |

**Anonymity is not cryptographic.** `anon_attributions` stores the real author id
in plaintext next to the public answer id. Read paths never return that linkage to
another user, but anyone with database access can attribute every anonymous row at
once. Treat the anon tier as "the operator won't tell", not "the operator can't
know". This is why a database dump is treated as a disclosure event rather than an
inconvenience.

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
