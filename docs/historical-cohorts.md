# Historical backfill and descriptive cohort scorecards (v1)

```
squire cohort <private-manifest.json> --trust-roots <external-public-roots.json> [--json] [--config <config.json>]
```

This **host-only, local import** command reads only explicitly listed immutable
files. It creates no controller, GitHub/Linear/Docker/Pi adapter, credential-helper
call, ticket, workflow mutation or network query. The default stdout is a JSON
identity (`schemaVersion`, `manifestDigest`, `artifactDigest`). `--json` prints the
normalized private report instead; operators must protect redirected output.
Errors are bounded and content-free. Neither mode prints source paths, session
IDs, transcripts, keys, signatures or raw disposition evidence. Run/ticket IDs,
model identifiers and other deliberately selected cohort metadata are private
report fields, not public diagnostics.

## Authority and non-goals

New runs' preferred accounting remains [controller telemetry](telemetry.md).
Historical Pi session JSONL is a different, explicitly **provisional** authority:
`provisional-pi-session-v1`. Importing an old session, its SHA-256, or a provisional
operator extraction never makes it controller-authoritative. Only structured
assistant-message usage is extracted; text/content/tool output is opaque and
cannot supply usage, outcomes, instructions or disposition. No price tables,
invoice reconstruction, transcript scraping, run discovery, current-time endpoint
estimates or automatic repairs are performed.

Squire completion, exact-head required CI, and merge are independent fields.
Unsigned/provisional usage can be counted even when CI and merge are unknown.
Lifecycle metadata and waste classifications are operator assertions with
versioned rules and evidence references, **not** controller observations. CI and
merge require separately authenticated evidence. All statistics are descriptive;
there are no causal model-quality claims or relaxed delivery gates.

## Closed input schema

The exported TypeScript types/validators in `cohort-manifest.ts` are the precise
version-1 schema. Every listed property is required; use `null` for unavailable
nullable values, never an invented zero. Unknown properties, duplicate decoded
JSON keys, malformed Unicode, rounded/noncanonical numeric lexemes, unsafe
integers, oversized inputs and excessive depth/counts are rejected.

| Object | Required fields |
| --- | --- |
| `CohortManifest` | `schemaVersion: 1`, `provenance` (SHA-256 identity), `optimizationMergeSha` (40-hex), `runs`, `baseline` (nullable) |
| `CohortRun` | `runId`, `ticketId`, `candidate` (nullable 40-hex), `side: pre/post`, `strata`, nullable `reservedAt`/`endedAt`, `completion: completed/failed/interrupted/unknown`, `lifecycleEvidence` (digest list), nullable `implementEntered`/`remediationAttempts`/`firstCandidate`/`ticketRunInventory`/`expectedSessions`, `sources`, nullable `disposition` |
| `firstCandidate` | `head`, `review` and `test` (`passed/failed/unknown`, specifically **first** Review and Test of the **first** Implement candidate), nonempty `evidenceRefs` |
| `ticketRunInventory` | `runIds` (explicit complete reservation inventory assertion for this ticket), nonempty `evidenceRefs`; repeat identically on the ticket's rows, or use `null` |
| `strata` | `repository` (`owner/repo`), `requiredCheckSet`, `requiredChecks`, `ticketClass`, `reviewGate`, `testGate`, `publicationGate`, `baselineSha`, `workflow`, `profiles`, `escalationPolicy`, `correctionPolicy`, `testSuite` |
| `HistoricalSource` | `artifact`, `sessionId`, `provenance`, `phase`, nullable `subphase`, `profile`, positive `attempt`, `correction`, `outcome`, nullable `startedAt`/`endedAt`, `waste` |
| `profile` | `provider`, `model`, `thinking` |
| `waste` | `ruleVersion: 1`, `kind: report/infrastructure/none/unknown`, `cause`, `evidenceRefs` |
| `ArtifactReference` | `root` and `file` (absolute normalized private host paths, file strictly beneath root), exact `bytes`, SHA-256 `digest` |
| `disposition` | `manifest` (artifact reference), `envelope` (nullable artifact reference) |
| `baseline` | `artifact` (immutable provisional operator artifact), `expected: {input, output, cacheRead, usageRecords, recordedCost}` |

Hashes identify immutable workflow/gate/policy/test-suite/provenance definitions.
`baselineSha` is 40-hex; other stratum identities are SHA-256 except repository,
ticket class, required check names and model profiles. **`requiredCheckSet` is
SHA-256 of canonical JSON of the lexically sorted unique required check names.**
This binds the expected check set, preventing a cohort input from silently
selecting only a passing subset of authenticated checks. `requiredCheckSetDigest`
validates and hashes this set. Required names and signed `checks[].name` share
one validator: nonempty Unicode strings of at most 256 UTF-8 bytes, excluding
control characters and unpaired surrogates. Spaces and punctuation are preserved
(e.g. `Analyze (javascript-typescript)` or `windows-launch-capture (22.9.0)`).
Names are never trimmed, case-folded, normalized or renamed; matching and duplicate
rejection use exact strings.

Identifiers use bounded non-whitespace ASCII forms; timestamps are exact UTC
`YYYY-MM-DDTHH:mm:ss.sssZ`. Decimal fields are canonical nonnegative decimal
strings with no exponent or trailing fractional zeros (up to 15 whole and 24
fractional digits). Counts are bounded safe nonnegative integers. Missing source
endpoints stay missing; known source intervals must fit the known run interval.
Plan subphases are `requirements` and `implementation-design` only. Outcomes are
`passed/failed/remediation_required/unknown`; corrections are separate sources.
Sources, session identities within a run, and run IDs cannot be duplicated.

Limits: 2 MiB manifest, depth 24, 50,000 JSON values; 256 runs, 500 sources/run,
2,000 sources/cohort; 64 MiB/source and 512 MiB total declared session bytes;
8 MiB/JSONL line, 200,000 lines/source; 100 required checks; 32 profiles and
32 evidence references/classification. External roots are at most 32 KiB/32 keys,
disposition payloads 128 KiB, envelopes 4 KiB, reports 8,000,000 bytes. Processing
is sequential across files. There is no unbounded directory enumeration.

The optimization merge SHA and each run's `side` are explicit operator-bound
fields, not inferred from dates or a GitHub query. A ticket cannot straddle sides
or incompatible accounting strata. To describe escalation within one ticket,
use the same declared profile set on its rows; actual source profiles remain
visible in phase/profile/outcome groups. Unlike full strata are never silently
pooled into one efficiency scorecard. `comparison` links pre/post stratum
identities only within equivalent repository/check-set/ticket-class/Review/Test/
publication gate classes; profile/policy/baseline differences remain shown.

## Detached Ed25519 disposition import

The independent host producer supplies a canonical payload, detached envelope and
operator-configured **public** trust roots outside repositories. Squire neither
accepts private keys nor offers signing commands. Do not place roots/signatures
or private evidence in model inputs, sandbox files or repository fixtures.
Tests generate ephemeral keys only.

`DispositionManifest` fields:

- `schemaVersion: 1`, `signedAt`, `runId`, `repository`, positive `prNumber`,
  exact `candidate`, `requiredCheckSet`;
- `checks: [{name, conclusion, completedAt}]`; names unique, bounded; conclusions
  `success/failure/cancelled/timed_out/skipped/neutral/action_required/unknown`;
- `prState: open/closed/merged`, nullable `mergeSha`/`mergedAt`, nullable
  `unmergedReason`, nullable boolean `reopened`;
- `signer` and `provenance` identities.

Merged requires merge SHA/time and no unmerged reason; other states require an
explicit unmerged reason and no merge fields. Completion/merge times cannot
exceed signed-at. CI passes only when every bound required check has `success`;
missing, skipped, neutral or unknown checks do not pass. Authenticated merge can
remain known even if CI is failed/unknown. Run, repository, exact candidate and
required-check-set mismatches make the imported disposition unknown.

The signed bytes are **exact UTF-8 canonical JSON**, recursively lexically sorted
object keys (including numeric-looking keys), arrays preserved, primitives only,
no duplicate keys, BOM, whitespace or terminal newline. Payload numbers are safe
integers; fractional schema fields use decimal strings. The shared bounded
forward-only scanner replaces regex tokenization both here and in report
correction/current telemetry. Canonical serialization rejects non-JSON values.

`SignatureEnvelope` contains exactly:
`schemaVersion: 1`, `manifestDigest` (SHA-256 of those exact payload bytes), `keyId`,
`algorithm: Ed25519`, canonical base64 64-byte `signature`, `signer`, `provenance`.
The digest is external to the signed payload to avoid a self-referential hash;
the normalized report retains it as payload identity, never as authentication.

`TrustRoots` is `{schemaVersion: 1, keys: [...]}`; each key has exactly `keyId`,
SPKI PEM `publicKey` (Ed25519), `signer`, `provenance`, nullable `notBefore`/
`notAfter`, and boolean `revoked`. Key IDs are unique. Multiple roots support
rotation. Verification uses **only** the exact configured key ID, evaluates its
validity at the signed-at time, and binds envelope/payload/key signer and
provenance identities. Unknown key, invalid/revoked/out-of-window key, unsupported
algorithm, missing signature, malformed bytes, digest mismatch or noncanonical
payload results in `unknown` with a bounded diagnostic. No fallback keys, network
lookups, historical trust invention or authentication by hash alone.

## Accounting and scorecards

Supported retained Pi v3 `session` headers must match the explicitly bound session
ID. Only `message` records whose `message.role` is `assistant` and whose supported
provider/API/model match their source binding supply usage. Record IDs and
assistant response IDs are deduplicated; malformed/duplicate sources fail closed.
Known Pi non-message records are ignored; unrecognized variants mark inventory
incomplete. Source content is never copied to the normalized report.

`input`, `output`, `cacheRead`, `cacheWrite` remain separate. Cost sums only the
recorded numeric `usage.cost.total`, using existing exact decimal arithmetic.
Missing/invalid dimensions preserve known subtotals but mark completeness false;
missing sources are not zero-cost sessions. Reports reconcile expected/listed/
supported sessions, assistant/usage-bearing records, per-dimension completeness,
active source time, run wall time, phase/subphase/profile/outcome groups and
independent dispositions. There is no double-counting of Plan subphases.

Rule-version-1 ticket scorecards expose sample sizes, unknown denominators and
unrounded numerator/denominator pairs (never a division-by-zero or rounded cost):

- **First-pass acceptance:** first Implement candidate passes its first Review,
  first Test and authenticated exact-head CI, divided by tickets known to enter
  Implement. Unknown entry counts and unknown acceptance results are separate.
  Missing reservation inventory/order/first-candidate evidence remains unknown.
- **Fresh runs:** distinct listed reserved IDs per ticket, including unmerged
  earlier attempts. Inventory completeness is separate from this known count.
- **Cost per merged ticket:** all attributed recorded run cost through verified
  merge, divided by merged tickets. Earlier failed/unmerged runs count. Unmerged
  tickets and unknown-merge tickets have separate counts/totals, never disappear.
  Runs after merge have separate totals; unknown timing/inventory prevents a
  complete claim. Conflicting merge endpoints yield unknown, not a guessed merge.
- **Wall time per merged ticket:** earliest reserved start through verified merge,
  including waits/retries. Missing run inventory or endpoints is incomplete.
  Active phase time is reported independently, not substituted for wall time.
- **Remediation, merge/reopen:** preserve known attempts and authenticated
  reopening booleans; unknown values stay unknown.
- **Waste:** an operator's source-level classification asserts the *whole*
  source's recorded work was lost solely to the named cause. Report causes are
  `report-validation` or `report-correction`; infrastructure causes are
  `provider`, `sandbox`, `controller`, `publication`, `ci-infrastructure`.
  Genuine code/test failure (`code-test`) cannot be infrastructure waste. Every
  known classification requires nonempty evidence references and rule version.
  Ambiguous/mixed causes must use `unknown`; no automatic causal classification.

All ticket rows must carry the same independently referenced reservation
inventory assertion, or `null`. Without this assertion, a selected successful
run cannot falsely certify all-ticket cost, first acceptance or earliest start.
Even a complete operator inventory is provisional, not controller authority.
Small samples (fewer than 30 tickets) and heterogeneous strata are explicitly
flagged. There is no claim that observed differences are caused by model quality.

## Private baseline reconciliation and storage

An operator supplies the exact selected run list, immutable expected extraction
artifact digest/size, and provisional expected totals in the private manifest.
The command verifies the original artifact bytes and reports exact per-dimension
deltas, matches, incomplete extraction or structured-usage variance. Legacy
operator artifact internals are deliberately opaque: the explicit expected
projection is a manifest assertion, not an invented parser for its private
schema. Never relabel this evidence as controller-authoritative or infer merge
from its totals. The private historical baseline is not shipped in this repo;
reproduction requires retained operator artifacts supplied out of band.

Publication is additive under `<dataDirectory>/cohort-artifacts/<artifactDigest>.json`.
The report binds canonical manifest digest, trust-root configuration digest,
source/evidence identities, provenance and rule version. Report bytes are
canonical; identical results reuse the existing artifact without rewriting it.
Different trust-root evaluations or recovered availability produce new artifacts,
not replacements. An existing name with mismatched content fails closed.
There is no timestamp in output that would make identical imports non-idempotent.

Linux uses retained no-follow ancestor/directory descriptors, current ownership,
0700 private parent/0600 files, inode/size/time/link/permission checks around
bounded reads, fsync and exclusive same-directory publication. Supported local
filesystems are ext-family, XFS, Btrfs, tmpfs, overlayfs and ZFS; unknown/remote/FUSE
types fail closed. Windows uses native local-NTFS retained read-only handles,
protected current-owner DACLs, no reparses/links, immutable identity checks and
exclusive atomic publication. `openHistorical` is a read-only extension of the
report lease with a separate 64 MiB limit, not a loosening of report limits or
production ACL validation. Unsafe/public/repository-contained inputs and outputs
are rejected. Source session/state files are never rewritten.

The exported APIs in `src/index.ts` include manifest validation/parsing, historical
extraction/totals, trust validation/disposition verification, scorecards, private
read/publication, backfill orchestration and reconciliation types/functions.
`backfillCohortFiles` is the complete safe file-import entry point. Pure aggregation
helpers consume already validated/bound inputs; they are not authentication
boundaries. Embedders should sanitize filesystem exceptions as the CLI does.

## Verification

Synthetic-only tests cover canonical escaped-quote/backslash adversaries with
linear consumed-step bounds, malformed/Unicode/numeric/duplicate inputs, ephemeral
Ed25519 keys and rotation, unknown evidence, exact check binding, completeness,
metric formulas, private filesystem races/permissions, additive idempotency,
privacy and action-adapter isolation. They run in `npm test` and in the existing
unconditional Windows Node 20.17/22.9/24 regression job. The ACL helper accepts
only exact full `FileSystemRights` enum names or numeric values, never PowerShell
abbreviations; the public-read test verifies the ACE before checking rejection.
Linux success is not evidence of Windows or CodeQL success. Publication/merge
still requires all clean exact-head hosted gates; no suppressions or skips are
introduced for the platform-neutral public-permission regression.
