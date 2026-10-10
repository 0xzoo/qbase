# qbase open data

qbase publishes the aggregate results of its questions as open data. A question is the unit: each release is one canonical question, its overall tally and the tally of every wave it was asked in, with the provenance needed to cite it.

## Licence

Aggregates are released under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Attribute "qbase (https://qbase.tech)". Every response carries a `Link: <…>; rel="license"` header, and the JSON carries the licence in its body.

Individual answers are not part of the release. Text answers are never released.

## Endpoints

| | |
|---|---|
| `GET /api/open/items?after=<id>&limit=<n>` | every releasable question, by id (`limit` up to 500; follow `next`) |
| `GET /api/open/items/:id.json` | one question: overall + per-wave tallies with provenance |
| `GET /api/open/items/:id.csv` | the same, long format: one row per (scope, label) |

## What is counted

- Each person's **latest** answer per scope (the question as a whole, or one wave of it). People can change their answer; only the current one counts.
- Only answers their authors gave as **Public** or **Anon**. Secret, Allowlist and Vault answers never enter.
- Only multiple-choice, checkbox and scale questions; not help requests, not safety-flagged questions.
- Votes for a label that isn't one of the question's declared options (or, on an open-options wave, its visible write-ins) are counted as `other`, and the label itself is not published.

## The floor

- A question is released only once at least **10** people have answered it.
- A scope (the question, or a wave) with fewer than 10 people publishes its `n` and nothing else (`below_floor: true`).
- Any count from 1 to 9 is withheld (`count: null`). Where the counts in a scope sum to `n` (multiple choice, scale, and the Public/Anon split), a single withheld cell withholds the next-smallest as well, so it can't be recovered by subtraction.

## Provenance

Each item carries:
- `wording_sha256`: a hash of the question's stem, type, options and scale config. If the wording changes, the hash changes; a series is comparable only across releases with the same hash.
- per wave: when it opened and closed, whether it is closed, its eligibility gate type, and `verified_humans: true` for World ID waves, where each counted answer came with a proof of a unique human.
- `generated_at`: when the release was computed.

## What this data is not

The respondents are self-selected and the tallies are unweighted. They describe the people who answered, not any population. A "verified human" is a unique person, not a representative one.

## Withdrawal

Withdrawal is forward-only. A release is computed from the answers as they stand at `generated_at`. When someone deletes an answer or makes it Secret, it leaves every release generated after that; releases already published stand. To cite a number, cite the item, its `wording_sha256` and its `generated_at`.

## Known limits

- A release is computed live. Comparing two releases taken close together can show how the most recent answers moved the tally, just as the live result pages do.
- Only answers given through people's accounts are counted. Model output (the council) is stored separately and never enters a tally.
