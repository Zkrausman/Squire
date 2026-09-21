# Private historical cohort scorecards (v1)

```
squire cohort /private/cohort.json --trust-roots /private/operators.json [--config /private/squire.json]
```

This is a **host-only, import-only** command. It prints JSON containing the
published private `path` and SHA-256 `digest`, not evidence or transcripts. It
constructs no GitHub, Linear, Docker, model or credential adapter. It never
signs, scans for runs, rewrites sessions/state/telemetry, reconstructs prices,
creates tickets, or changes workflow policies or delivery gates.

## Authorities

* Validated persisted run state establishes Squire completion, reservations,
  phase attempts and accepted results. Completion/publication is not CI or merge.
* Validated `RunTelemetry` retains its existing controller-capture authority.
* Retained Pi v3 session JSONL establishes **provisional historical** usage only.
  Source SHA-256 and header session UUID bind the extraction, not its authenticity.
  A source cannot become `RunTelemetry`, even if its totals match current usage.
* Independently produced and authenticated disposition manifests establish
  exact-head CI and merge/reopen facts. Missing, conflicting or unauthenticated
  evidence remains unknown. No GitHub query or merge inference occurs.

When controller and historical records both exist, the run uses controller
accounting, never their sum. Historical rows remain available for private baseline
reconciliation. A state/telemetry binding mismatch makes current accounting
unknown. Historical extraction never repairs the controller ledger.

## Closed input schemas

The exported TypeScript interfaces and runtime validators are in
`src/personal/cohort-domain.ts` and `disposition-evidence.ts`. Unknown fields,
duplicate identities, unsafe numbers/paths and unsupported versions are rejected.
All timestamps are valid UTC ISO strings with millisecond precision. SHAs are
lowercase (40 hex for commits, 64 for SHA-256). Costs are canonical nonnegative
decimal strings (no exponents or trailing fractional zeroes); counts are safe
nonnegative integers. Control JSON rejects duplicate members and unsafe numeric
lexemes. Labels are bounded identifiers; check names also allow printable spaces.

`CohortSpec`:

* `schemaVersion: 1`, `optimizationMergeSha`: explicit optimization boundary;
  Squire does not infer which side a run belongs to.
* `runs`: 1–100 explicit `CohortRun` entries:
  * `runId`, `ticketId`, `side: "pre" | "post"`, `candidateHead`,
    `prNumber` (positive integer or null).
  * `stratum`: `repository` (`owner/repo`), `requiredCheckSet`,
    sorted unique `requiredChecks`, `ticketClass`, `reviewGate`, `testGate`,
    `publicationGate`, `baselineSha`, `workflow`, sorted unique `modelProfiles`,
    `escalationPolicy`, `correctionPolicy`, `testSuite`.
  * `sources`: 0–100 explicit historical source entries with `path`, `digest`,
    `sessionId`, `phase` (`plan/implement/review/test/retro/unknown`) and `profile`.
    Phase/profile attribution is operator-supplied provisional metadata.
  * `disposition`: null or `{manifest: {path, digest}, envelope: {path, digest}}`.
* Optional `baseline`: `artifactDigest`, `extractionIdentity`, unique `runIds`
  selected from `runs`, `input`, `output`, `cacheRead`, `messages`, `recordedCost`.
  This is a **provisional/untrusted target**, not an authenticated disposition.

All source paths must be absolute, normalized and control-character-free.
No duplicate source paths, digests or session UUIDs are accepted. There are at
most 1,000 historical sources per cohort. Each JSON/control/output file is at most
2 MiB; sessions at most 64 MiB each, 256 MiB per invocation, 200,000 records and
8 MiB per line. JSON nesting is bounded to 100. Exceeding a historical bound
makes that source unavailable; oversized control/output artifacts fail closed.
For large cohorts choose smaller explicit cohorts rather than weakening bounds.

`DispositionManifest` (canonical signed payload):

* `schemaVersion: 1`, `runId`, `repository`, positive `prNumber`, exact `head`,
  `requiredCheckSet`.
* `checks`: 1–100 unique `{name, conclusion, completedAt}` entries. Names must
  exactly equal the spec's required set, not just a successful subset.
  Conclusions: `success/failure/cancelled/timed_out/neutral/skipped/unknown`.
  Only all-success establishes passing CI; neutral/skipped remain unknown.
* `prState: "open" | "closed" | "merged"`; `merge: {sha, at}` for merged,
  otherwise null. `unmergedReason` is null for merged, otherwise a reason identifier.
* `signedAt`, `source` and `signer` provenance identities. Check and merge times
  cannot be later than `signedAt`.
* `reopened`: boolean or null (absence of proof is null, never false by inference).
* `waste`: 0–1,000 unique session classifications, described below.

`SignatureEnvelope`:

```
{schemaVersion: 1, manifestDigest, keyId, algorithm: "Ed25519", signature, signer}
```

`manifestDigest` is SHA-256 of the exact payload bytes (not a self-referential
field inside the payload). `signature` is canonical padded base64 of the 64-byte
detached signature. The signer must match both the payload and the selected root.

Payload canonicalization recursively sorts object keys lexicographically, preserves
array order, and permits JSON primitives only. There is **no** whitespace, newline
or BOM; numbers must be safe integers (decimal quantities use strings). Alternate
escapes, duplicate keys and noncanonical bytes are rejected before authentication.
Use exported `canonicalCohortJson` to produce bytes in the independent producer.
SHA-256 is an identity, **not authentication**.

## Operator trust roots

An explicit private file **outside every repository** has this closed shape:

```
{schemaVersion: 1, keys: [{keyId, publicKey, signer, notBefore?, notAfter?, revoked?}]}
```

Up to 32 unique key IDs are allowed. `publicKey` is Ed25519 SPKI PEM (`BEGIN PUBLIC
KEY` only). Optional validity bounds are inclusive at the manifest's `signedAt`,
not the current wall clock. A revoked key is always rejected. For rotation retain
old public roots as required, add a new exact key ID and its validity window; no
fallback key selection is attempted. Root bytes' digest is recorded in the artifact,
so changed rotation/revocation policy produces new additive output.

Unknown keys, unsigned manifests, wrong keys/signers/algorithms, invalid signatures,
noncanonical bytes, wrong digests and invalid validity windows yield unknown with
bounded allowlisted diagnostics. Unreadable/invalid trust configuration does not
prevent usage reporting. Putting the root file in a repository is a command error.
Private keys and signing commands are **never** accepted or stored by Squire; the
independent operator producer owns signing outside model/sandbox/config/state.
Tests generate ephemeral keys only.

## Accounting and metrics

Extraction rule `pi-session-v3-assistant-usage-v1` inspects only structured Pi
`type: message` records whose `message.role` is `assistant`. Header version/UUID,
record uniqueness, exact file digest and stable private read must validate.
Only `message.usage` is counted; user/tool usage and content are not parsed as
accounting. Uncached `input`, `output`, `cacheRead`, `cacheWrite` remain separate.
Only recorded `usage.cost.total` is summed with decimal arithmetic, not component
prices or inferred cost. Missing fields retain known subtotals and incomplete
flags. This is Pi-recorded USD, not an invoice. Historical active time is unknown.

Rule `cohort-v1` exposes observations, per-ticket reconciliation and scorecards:

* Each scorecard is a **full stratum and side**, not a pooled pre/post estimate.
  Gate class requires equal repository/check-set/ticket class/Review/Test/publication
  gates. Baseline/workflow/profiles/policies/suite are exposed stratification fields,
  not requirements for exact model equality across comparisons. Phase, actual
  profile, invocation outcome and authority groups remain visible inside a stratum.
  Tickets crossing strata are exposed and excluded from stratum-level ticket ratios.
* First-pass acceptance: accepted tickets / tickets entering Implement. Requires
  the earliest enumerated Implement run, first Implement/Review/Test results all
  passing, Review/Test on that candidate, and authenticated passing exact-head CI.
  Missing chronology or superseded first-attempt evidence stays unknown. A known
  first failure or remediation is not a first-pass acceptance.
* Fresh runs: distinct run IDs backed by reserved state. Missing states are counted
  separately, not silently treated as no attempt. Per-merged-ticket numerator
  includes unsuccessful runs for that ticket. Unmerged ticket attempts stay visible.
* Remediation attempts come from persisted Review/Test remediation counters, not
  fresh runs, report corrections or repeated provider launches.
* Cost per merged ticket: known recorded cost of **all enumerated runs** attributable
  through verified merge / merged tickets. A run with unknown endpoints or spanning
  merge has unknown cost allocation, not an invented prorating; it remains in
  ticket totals and `throughMergeUnknownRuns`. Unmerged/unknown tickets have separate
  counts and costs. Zero merged tickets yields denominator 0, never a fabricated ratio.
* Wall time: earliest enumerated reservation to verified merge, including waits and
  retries; active phase time is separately summed from invocation durations.
* Waste is never inferred from a generic failure. Only authenticated manifest
  classifications with `ruleVersion: "cohort-v1"`, `sessionId`, `kind`, `reason` and
  1–20 SHA-256 `evidence` references can classify a current session. References must
  include that session's stream digest. `report` requires `report-validation-only`;
  `infrastructure` requires `provider/sandbox/controller/publication/ci-infrastructure`;
  genuine `code-test` is `none`; `ambiguous` is `unknown`. Report classification
  asserts work lost solely to result/report validation after code-producing work.
  Missing, mismatched, ambiguous and historical classifications remain unknown.
  Unmerged waste is included. Unproven time/cost remains incomplete.

`known` is a subtotal, not a replacement for null evidence. Dimension completeness
is distinct from inventory completeness. Explicit source enumeration cannot prove
all historical sessions or all fresh runs for a ticket, so historical run inventory
and all-ticket-run completeness are false. Even apparently successful ratios are
marked incomplete at the all-runs level. Ratios use numerator/denominator objects,
not floating-point estimates. All scorecards are descriptive; small/heterogeneous
samples support **no causal model-quality claim**.

## Private baseline reconciliation

The operator supplies the private cohort's exact run list, source paths/digests,
provisional baseline artifact digest, extraction identity and expected totals in
`baseline`. Do not put real identifiers, baseline values, paths or evidence in a
repository fixture. An unsigned historical baseline may reconcile usage while
all authoritative CI/merge claims remain unknown.

Run the command against retained artifacts, inspect the private JSON's `baseline`:
expected target, observed historical-only totals, signed per-field deltas, source
completeness, extraction rule and allowlisted variance reasons. Missing/unsupported
sources, incomplete usage and different extraction rules are reported explicitly;
remaining variance is `unexplained_variance`, never an invented explanation. The
real baseline requires operator-held artifacts; repository tests use only synthetic
fixtures and do not claim to reproduce private evidence they cannot access.

## Storage, retention and API

Canonical output is published to
`<dataDirectory>/cohort-artifacts/<sha256-of-output-bytes>.json` with exclusive atomic
publication. Identical evidence reuses identical bytes; changed evidence produces a
new digest/path. A conflicting existing file fails closed. Linux uses fd-relative
no-follow stable reads, owned private 0700 directories/0600 files, exclusive links
and fsync. Windows uses native protected-DACL/no-reparse stable handles, exact Buffer
reads and exclusive publication. Symlinks, special files, unsafe ownership/ACLs,
changing files and oversized sources are unavailable. No source bytes are modified.
A crash leaving an incomplete/conflicting publication fails closed; do not promote
it manually to an accepted artifact.

Retain/remove cohort artifacts with the configured private data root and associated
operator evidence. The artifact contains run identities and evidence digests but
not input paths, prompts, transcript text, key material or signatures. Do not copy
private artifacts to the repository, outbox, or model sandbox. Terminal failures
are sanitized. Existing current telemetry CLI/authority is unchanged.

Stable APIs exported from `src/index.ts`: cohort interfaces/validators,
`canonicalCohortJson`, `parseBoundedJson`, `parseCanonicalJson`,
`verifyDisposition`, `extractHistoricalTelemetry`, `readHistoricalTelemetry`,
`reconcileCohort`, `aggregateCohort`, `readCohortSpec`, `publishCohort`, `runCohort`.
Use `runCohort` for the complete host trust-root/location/storage boundary; lower-level
pure APIs require trusted caller-supplied typed stores and configuration.
