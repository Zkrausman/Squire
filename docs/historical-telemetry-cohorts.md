# Historical telemetry cohorts (v1)

This is a **host-only, offline accounting workflow**, not a new delivery gate.
It never starts Pi, signs evidence, queries GitHub, mutates a run, changes policy,
creates tickets, rewrites sessions, or infers a merge. Current-run controller
telemetry retains its existing authority; retained session usage is provisional.
Small and heterogeneous samples are descriptive only: no causal model-quality
claim, pricing reconstruction, or provider-invoice claim is made.

## Operator workflow

1. Place the explicitly selected immutable evidence under the configured private
   `dataDirectory`, **outside the repository**. Retain original bytes. Linux files
   must be current-user-owned, single-link regular files with no group/other
   permissions, inside private directories; symlink traversal is rejected.
   Windows requires local NTFS, protected private ACLs and no reparses. Prepare
   Windows evidence through an independent protected host export, not ordinary
   repository copies. The command never repairs permissions or rewrites sources.
2. Prepare a closed v1 request using
   [`contracts/cohort/v1/cohort.schema.json`](../contracts/cohort/v1/cohort.schema.json)
   (`$defs.request`). All members are required; absent optional evidence is `null`.
   Paths must explicitly name individual files; there is no directory discovery.
   Each source has an operator-assigned bounded `identity`, `path`, and exact-byte
   SHA-256. Reusing an identity with different bytes/path is a conflict.
3. Independently produce any disposition or Squire attestations, and their detached
   signature envelopes, on the host evidence producer. Squire accepts **no signing
   key, signing command or GitHub adapter**. Unsigned historical dispositions are
   legitimate inputs, but remain unknown for CI and merge.
4. Put the public-only trust-root document (`$defs.trustRoots`) in explicit operator
   configuration outside repositories. An empty key list is allowed for entirely
   provisional imports. Do not put keys/configuration in a model sandbox.
5. Run:

   ```text
   squire cohort /private/request.json --trust-roots /private/public-keys.json --config /private/squire.json
   ```

   Stdout is one JSON receipt: `schemaVersion`, `artifactDigest`, `manifestDigest`,
   and private artifact `path`. Failure diagnostics are fixed, sanitized messages.
   Stdout is private operator output too; do not paste it into a public ticket.

The command publishes one canonical document (`$defs.publication`) atomically at
`<dataDirectory>/cohort-artifacts/<input-identity>.json`. The input identity hashes
normalized canonical request/trust-root identities and their original file-byte
digests. Request inventory lists are sorted for normalization; signed evidence
arrays are never reordered. Original request and trust-root byte digests remain
in the provenance manifest. The enclosed provenance manifest hashes
canonical scorecard bytes; its detached `manifestDigest` hashes canonical manifest
bytes (there is no self-referential digest). Equal existing bytes return unchanged;
conflicts fail closed. A sealed incomplete snapshot is not overwritten when more
evidence becomes available: use a new `cohortId`. Key rotation changes the input
identity, preserving earlier imports.

Limits: 256 runs/request, 256 historical sources/run, 2,048 sessions and source
reads, 64 MiB/file, 256 MiB total bytes, 200,000 JSONL records, 8 MiB/line,
100 JSON container levels, 200,000 JSON values/document, 2 MiB request/trust-root/
manifest/publication, and 1,024 comparable pre/post pairs. Excessive requests fail
rather than sampling or dropping runs. Unsupported historical data is visibly
incomplete. Budget limits are not knobs that models can change.

## Preparing a request

A synthetic single-run descriptor looks like this (replace all synthetic values
and digests locally; never commit real baseline identities or paths):

```json
{
  "schemaVersion": 1,
  "cohortId": "synthetic-cohort",
  "optimizationMergeSha": "cccccccccccccccccccccccccccccccccccccccc",
  "runs": [{
    "runId": "synthetic-run-0001", "ticket": "SYNTH-1",
    "repository": "fixture/repository", "candidateSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "pr": 1, "requiredCheckSet": {"identity": "checks-v1", "names": ["ci", "codeql"]},
    "period": "pre",
    "strata": {
      "ticketClass": "maintenance", "reviewGate": "review-v1", "testGate": "test-v1",
      "publicationGate": "publication-v1", "baselineSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "workflow": "workflow-v1", "profiles": ["openai/fixture-model/medium"],
      "escalationPolicy": "none", "correctionPolicy": "none", "testSuite": "suite-v1"
    },
    "sessions": [], "telemetry": null, "disposition": null, "squire": null
  }],
  "baseline": null
}
```

This valid example intentionally produces **unknown accounting**, not zero-cost
success. Add historical sources as `{source:{identity,path,sha256}, sessionId,
format:"pi-0.84.4-session-v3", phase, profile:{provider,model,thinking}}`. The actual
`provider/model/thinking` must appear in the stratum's `profiles`. `phase` may be
`unknown`; no phase is inferred from a filename or transcript.

Alternatively `telemetry` references the existing exact-run
`<paths.staging>/telemetry/<runId>/summary.json`. A file with a controller-looking
`authority` label at any other location is rejected. The current controller's
validator and completeness reconciliation are reused. A run cannot include both
controller telemetry and historical sessions (preventing double counting).

`period` and `optimizationMergeSha` are explicit operator assertions, not inferred
from dates. Runs of one ticket cannot straddle periods or incompatible gate
classes. Each model/policy/workflow/baseline/test-suite stratum stays visible,
including tickets with multiple model strata. No model-profile equality is
required for a **pairwise comparison** within a gate class; such comparisons have
`strataDiffer: true`. Different repository/check-set/ticket-class/Review/Test/
publication gates never get compared. Group indices bind every pre/post delta to
its two displayed strata, without pooled heterogeneous denominators.

## Retained Pi backfill and authority

Supported source shape: Pi 0.84.4 session JSONL v3 header followed by identified
session-tree entries (`id`, `parentId`, `timestamp`). Header session identity must
match the request; parent links and entry IDs must be coherent. Source digest and
file identity are checked. Only structured assistant-message `usage` contributes:
uncached `input`, `output`, `cacheRead`, `cacheWrite`, usage-bearing records, and
recorded `usage.cost.total`. Supported provider/API pairs match the pinned current
telemetry adapters. Response identities are deduplicated within and across
explicit historical sources. Duplicate entry, session, response or run bindings
fail closed. Cost is summed with exact fixed-point decimals, never a price table.

Content, prompts, cwd, summaries, tool results and paths never enter scorecards.
Usage on unsupported non-assistant records (including compaction accounting) is
not silently added; it marks completeness unknown. Supported known dimensions
remain subtotals when another dimension is absent. Malformed/digest-mismatched/
truncated sources contribute unknown accounting, never invented zeros. Session
message timestamps are **not** active phase duration, so historical active time
remains unknown. All backfill rows are labeled
`provisional-pi-0.84.4-session-v3`, never controller-authoritative.

## Detached import authentication

Manifest schemas: `$defs.disposition` and `$defs.squire`. Both bind schema version,
kind, run, ticket, repository, PR, candidate SHA, required-check-set identity/names,
signed-at time, signer and provenance. They are **separate signed documents**.
Use `canonicalJson` on schema-validated JSON: recursively lexicographically sorted
object keys (UTF-16 code-unit ordering), preserved array order, no insignificant
whitespace, BOM or newline. Numeric fields are safe integers; recorded decimal
amounts are canonical strings. Duplicate decoded keys (including escaped aliases)
are rejected *before* decoding. Exact bytes, not a reserialized approximation,
are signed and SHA-256 hashed.

The detached envelope contains `schemaVersion:1`, `manifestDigest`, exact `keyId`,
`algorithm:"Ed25519"`, canonical base64 64-byte signature, `signer`, `provenance`,
and `signedAt`. The envelope's identities/time must equal the signed payload and
configured trust root. SHA-256 is identity only, **not authentication**.

Each configured root has `keyId`, SPKI `PUBLIC KEY` PEM, `signer`, `provenance`,
`notBefore`, `notAfter`, `revoked` (null windows mean unrestricted). Multiple roots
support rotation, but only the exact key ID is tried. Validity is evaluated at the
signed-at time; revoked roots are rejected. Private-key PEM is explicitly rejected
before crypto import. Duplicate key IDs, invalid/non-Ed25519 roots and unknown
configuration members fail closed. Fixtures generate ephemeral keys at test time;
Squire has no production signing API.

Noncanonical bytes, malformed data, wrong digests, unknown/revoked/out-of-window
keys, bad signatures, missing envelopes, mismatched bindings, or impossible claim
semantics produce **unknown CI and merge** with allowlisted diagnostics. A valid
signature never fixes a wrong candidate or check set.

A disposition lists per-check name, head SHA, conclusion and completion time;
checks must be unique, exact-head bound and completed no later than signed-at.
Required-check names and imported check names use the same nonempty Unicode
string schema, bounded to 256 characters and excluding C0/C1 controls. Spaces,
parentheses and other matrix punctuation are preserved (for example,
`windows-launch-capture (20.17.0)`). Names match exactly: no trimming, case folding
or normalization. Check-set identities retain the separate restricted identity syntax.
Every required check must explicitly succeed for `ci:passed`. Known failures are
failed; missing/skipped/neutral/unknown checks are not successes. Merge requires
`prState:merged` and explicit merge SHA/time. Open/closed states require an explicit
unmerged reason; `not_verified` remains unknown. Merge can be verified while CI
fails or is unknown: the claims are independent, not delivery permissions.
`reopened` is a separately attested boolean/null, not inferred from PR state.

## Metrics and evidence (ruleVersion 1)

Squire attestations separately bind completion, reservation time, optional observed
`endedAt`, whether the run
entered Implement, its first candidate and Implement ordinal, first Review/Test
attempts/outcomes, per-run remediation count, and per-session waste classifications.
`reservedRunIds` is the producer's complete ticket run inventory.
`accountedSessions` binds every session ID to its source digest; historical
inventory completeness requires an exact match to the enumerated sources. Complete ticket
metrics require all imports to attest exactly the enumerated run set and complete
accounting inventory. Missing/ambiguous inventory never becomes a zero-attempt
success. Controller completion can also be read independently from its terminal
artifact. Conflicting independently bound completion claims fail closed.

* **First-pass acceptance:** tickets whose first Implement candidate passed first
  Review and Test and exact-head CI / tickets entering Implement. A changed head,
  missing prior-entry evidence, unknown candidate or unknown CI cannot pass. Unknown
  numerator and denominator counts are reported separately.
* **Fresh runs:** distinct reserved run IDs per ticket; displayed per merged ticket
  and separately for unmerged/unknown tickets. Verified unmerged attempts (including
  failed attempts of eventually merged tickets) keep their own cost/time totals.
* **Cost per merged ticket:** all known run costs through verified successful merge
  / merged tickets. Missing inventory or dimensions makes the numerator a visibly
  incomplete subtotal. Known post-merge or boundary-crossing sessions are separated, not wholly
  charged to the prior merge. An unknown terminal endpoint or a crossing session
  makes through-merge accounting incomplete rather than inventing a cutoff. Unmerged/unknown tickets remain separate categories.
* **Wall time per merged ticket:** first attested reservation through explicit
  verified merge, including waits/retries, / merged tickets. Active session wall
  durations are separate; unknown historical active time is never fabricated.
* **Remediation:** attested per-run counts, not guessed from launch count, model
  escalation, report correction, or a nonzero attempt number.
* **Report waste:** only independently attested full sessions whose code-producing
  work/cost/time was lost solely to report/result validation or correction failure.
* **Infrastructure waste:** only independently attested full sessions repeated or
  stranded solely by provider, sandbox, controller, publication or CI infrastructure;
  genuine code/test failures belong to `code`, not infrastructure.

Each waste classification has rule version and evidence digests including the
accounted session's source digest; otherwise it stays unknown. `none` is explicit
negative evidence. Partial-session losses are unsupported and must remain unknown,
not guessed from timestamps. Unknown classifications preserve their recorded costs
in `unknownWaste` and make report/infrastructure waste totals incomplete.

Ratios use exact `{numerator,denominator,complete}` instead of floating-point dollar
rounding. Pairwise deltas are **post minus pre**, expressed as an exact signed
numerator and denominator; incomplete or zero-denominator comparisons are `null`.
Counts/outcomes and every stratum's raw metrics remain visible. Phase/profile/
outcome/authority grouping is separate from the ticket denominators.

Each accounting dimension has `known`, `expected`, `observed`, `supported`,
`unknown`, `excluded`, `complete`. Historical units are assistant records; current
controller units are captured sessions. Unknown inventories add an explicit unknown
unit. These are coverage units, **not** a fraction of billable tokens; mixed
historical/current completeness is descriptive only. Empty collections have no
proved denominator and are incomplete. Run/ticket/source reconciliations and source
receipts show bound bytes observed versus semantically supported. No private error
text is emitted. Outputs are closed, versioned JSON schemas; schema validation is
not a substitute for signature verification or trusted private provenance.

## Private baseline reconciliation

`baseline` optionally contains a source reference, an explicit subset of pre-run
IDs, and JSON pointers for `input`, `output`, `cacheRead`, `messages`, `recordedCost`
inside the operator artifact. This accommodates the provisional extraction's
original shape without rewriting it. Only these typed numeric fields are read;
other baseline payload never enters the output. The exact source digest binds the
operator extraction; it remains `provisional_operator_extraction`, even if totals
match. Results provide expected/observed/exact signed variance, completeness, and
one of: matched, unavailable baseline field, incomplete/unsupported sources, or
structured usage differs from extraction. Individual source receipts, sessions,
and accounting dimensions let operators explain the latter without transcript
scraping. Missing cache-write evidence is never folded into cache-read.

To reproduce a private historical cohort, put its exact reserved IDs and supplied
artifact digest in the **private request**, map the five extraction fields, and
retain the generated publication digest/totals privately. Repository tests cover
only synthetic cohorts; no real baseline, run identity, session path, prompt, or
private key belongs in source control. Keep source evidence, public-root versions,
requests and immutable publications under the same operator retention policy.
Deletion/retention is an independent host operation, never a cohort command side
effect. Reproduction and exact-head CI require the independently supplied private
artifacts and external Linux/Windows/CodeQL gates; unit tests cannot invent them.

## API and regression gates

`src/index.ts` exports the closed schemas/types, `decodeCohortDocument`,
`validateCohortDocument`, `backfillSession`, `verifyEvidence`, `disposition`,
`assembleCohort`, `runCohort`, and bounded JSON APIs. Pure parsers/assemblers preserve
unknowns; `runCohort` is the private publication workflow. Input schemas are also
compiled by `npm run validate:contracts`.

Both report duplicate-member rejection and current Pi-stream canonical-number
validation use `bounded-json.ts`, a forward-only grammar scanner. It validates
strings/escapes/Unicode, number lexemes, delimiters, nesting, duplicate decoded keys
and trailing data before JSON decoding. JSON-valid isolated UTF-16 surrogates are
preserved; malformed Unicode escapes/UTF-8 are rejected. Cursor steps consume each
code unit once; token decoding covers disjoint spans. No regex token search or
CodeQL suppression is used. Long escaped-quote/backslash adversaries have explicit
step and time bounds. New scanner, private-store, backfill, import and cohort tests
run in both the full suite and the unconditional Windows regression matrix. Native
Windows artifact reads have a separate read-only 64 MiB lease; report creation and
report evidence retain their existing 2 MiB limit.
