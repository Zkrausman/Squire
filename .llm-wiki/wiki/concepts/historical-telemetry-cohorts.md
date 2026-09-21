---
type: concept
domain: engineering
confidence: high
---

# Historical telemetry and cohort scorecards

`squire cohort MANIFEST --trust-roots PUBLIC-ROOTS [--json] [--config FILE]` is a
host-local explicit-file backfill/import command. It constructs no controller or
network/action adapters. Source sessions/state are never rewritten; normalized
canonical artifacts are additive and digest-addressed under the configured
private data root's `cohort-artifacts` directory. Identical imports reuse bytes;
conflicting content fails closed. Trust-root changes or recovered availability
produce new artifacts, not replacement history. Default stdout is only identity;
full JSON remains private, containing selected run/ticket/profile metadata but
no source paths, transcripts, keys or signatures.

Historical Pi v3 session usage has authority `provisional-pi-session-v1`, never
[controller telemetry](durable-run-telemetry.md). Only bound structured assistant
usage contributes, keeping input/output/cache-read/cache-write separate and
summing recorded `usage.cost.total` with exact decimal arithmetic. Unsupported,
missing, duplicate or malformed evidence stays incomplete. Expected/listed/
supported session inventories, usage-bearing records, dimension completeness,
phase/subphase/profile/outcome groups and time boundaries remain visible. There
is no pricing reconstruction or transcript-derived accounting.

Completion, required exact-head CI and merge are independent. Only imported
canonical manifests authenticated with detached Ed25519 signatures can establish
CI/merge. The independent host producer controls signing; Squire accepts only
explicit external public trust roots. Payload bytes have recursively lexical
keys, preserved arrays, no whitespace/BOM/newline/duplicate keys, safe integers
and canonical decimal strings. SHA-256 is identity, not authentication. Envelope,
payload and configured exact key ID bind signer/provenance; validity/revocation
is evaluated at signed-at. No alternate-key trial, network lookup or historical
trust invention. Unsigned/unbound/malformed evidence means unknown. The required
check-set identity hashes canonical sorted unique required names, preventing
passing-subset selection. Missing/skipped/neutral checks cannot pass.

The shared bounded forward-only JSON scanner replaces regex tokenization for
canonical evidence, report correction and current telemetry numeric validation.
Decoded duplicate keys, malformed escapes/Unicode, noncanonical numeric lexemes
and configured byte/depth/item bounds fail closed. Adversarial escaped-quote and
backslash tests assert linear consumed steps rather than timing-only guesses.

Cohorts explicitly bind an optimization merge SHA and each run's pre/post side.
Comparable gate classes require the same repository, required check set, ticket
class and Review/Test/publication gate identities. Full strata additionally show
baseline SHA, workflow, profiles, escalation/correction policies and test suite.
Unlike strata are not silently pooled. One ticket cannot straddle sides/strata;
actual source profiles remain visible within a declared profile set.

Rule-versioned scorecards retain first-candidate/first-Review/Test/exact-head-CI
acceptance, distinct reserved runs, remediation, authenticated merge/reopen,
recorded cost across all attributed runs through merge, earliest-reservation-to-
merge wall time and separate active phase time. Earlier unmerged attempts count;
unmerged tickets, unknown merge, postmerge runs and unknown timing stay separate.
An explicitly referenced ticket reservation inventory is necessary to certify
all-ticket cost, first acceptance or earliest start. Unknown inventory never
becomes a complete selected-run subtotal. Lifecycle/inventory/waste evidence is
operator-provenance, not controller authority. Waste is classified only by
explicit rule-versioned sole-cause evidence; genuine code/test failure is not
infrastructure waste. Ambiguity remains unknown. Small/heterogeneous cohorts are
descriptive only, with no causal model-quality claims.

Baseline reconciliation accepts an out-of-band immutable operator artifact and
manifest-declared expected projection, verifies its digest and emits exact
per-dimension matches/deltas/incompleteness. Its legacy internals are opaque and
provisional. Never commit real baseline identifiers, paths, prompts, private
evidence or keys. Repository fixtures use synthetic data and ephemeral keys.

Private files use Linux no-follow retained descriptors, local filesystem,
owner/mode/identity checks and exclusive fsync publication, or Windows native
local-NTFS protected ACL/no-reparse retained leases. Public-permission regression
fixtures must use exact full `FileSystemRights` enum names/numeric values, not
ambiguous abbreviations. New suites belong in the unconditional Windows matrix
and its executable workflow validator. Local Linux tests do not certify hosted
exact-head Windows or CodeQL gates; imports never weaken delivery gates.

Schema, bounds, API and operator details: [docs/historical-cohorts.md](../../../docs/historical-cohorts.md).
Implementation: `src/personal/{canonical-json,cohort-manifest,historical-telemetry,evidence-verification,cohort-scorecard,private-cohort-store,cohort-backfill}.ts`.
