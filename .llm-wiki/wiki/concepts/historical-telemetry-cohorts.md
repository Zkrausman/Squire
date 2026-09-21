---
type: concept
domain: engineering
confidence: high
---

# Historical telemetry cohorts

`squire cohort REQUEST --trust-roots PUBLIC-KEYS [--config FILE]` is an offline,
host-only accounting command. It reads only explicitly enumerated private files,
never starts models, queries GitHub, signs claims, mutates workflow state or
weakens delivery gates. Its closed v1 schemas and stable library APIs are exported
from `src/index.ts`; detailed operator rules are in
[historical telemetry cohorts](../../../docs/historical-telemetry-cohorts.md).

## Separate authorities

- Current-run telemetry still means trusted controller capture at the exact-run
  private summary location, not a file with a controller-looking label.
- Pi 0.84.4 session-v3 JSONL backfill is **provisional historical evidence**. Only
  structured assistant usage is counted; source/run/session digests and unique
  entry/response identities bind provenance. Input/output/cache-read/cache-write
  remain separate, and recorded `usage.cost.total` is summed as exact decimals,
  never reconstructed from prices. Content is opaque. Historical message times
  do not establish active phase duration. Usage on any non-assistant message,
  including recognized compaction/branch summaries, is unsupported: retain known
  assistant subtotals but mark accounting incomplete rather than silently skipping
  that usage or inferring its meaning from content.
- Squire completion, exact-head CI, and merge are independent. CI/merge evidence
  is import-only, from independently produced canonical manifests with detached
  Ed25519 envelopes. SHA-256 identifies bytes; it does not authenticate them.
  Only the exact externally configured public-key ID, signer, provenance and
  signed-time validity window can authenticate a claim. Revoked, malformed,
  unsigned, noncanonical or unbound evidence stays unknown. Private signing keys
  and signing operations are never accepted. Required-check names and imported
  check names share a bounded, nonempty, control-free Unicode string schema (256
  characters maximum), not the restricted identity syntax. Spaces and matrix
  punctuation are preserved; matching is exact, with no trimming or case folding.
- Separate signed Squire attestations bind reservation/endpoints, ticket run and
  session-source inventory, first candidate/Review/Test, remediation, and waste
  classifications. Unsupported or ambiguous classifications remain unknown.

## Reproducibility, metrics and privacy

The private request explicitly states pre/post period and optimization merge SHA.
Comparable gates require the same repository, check set, ticket class and
Review/Test/publication gates. Baseline, workflow, profiles, escalation/correction
policy and test suite remain visible strata. Pairwise same-gate comparisons may
show different profiles; unlike strata are never silently pooled. Small samples
and all comparisons are descriptive, never causal model-quality evidence.

First-pass acceptance requires first Implement candidate, first Review/Test and
exact-head CI among tickets entering Implement. Fresh runs count distinct reserved
IDs, including failed/unmerged attempts. Through-merge cost includes all attributed
runs through explicit verified merge; unmerged and unknown tickets retain separate
denominators. Lifecycle wall time spans first reservation to merge (including
waits), separately from active session time. Report/infrastructure waste requires
versioned independent cause evidence bound to each counted session; code/test
failures are not infrastructure. Ratios and deltas preserve exact numerators and
denominators; missing values never become zero. Reconciliation is per dimension,
run, ticket, phase/profile/outcome and source.

The optional baseline references an original private operator extraction by digest
and typed field pointers. Reconciliation reports known totals, completeness and
field-by-field variance without copying its payload or relabeling it authoritative.
Real historical run inventories, paths, prompts, private keys and evidence must
never enter source control; tests use synthetic data and ephemeral fixture keys.

Publication is additive, canonical and atomic beneath
`<dataDirectory>/cohort-artifacts`. Its provenance manifest hashes scorecard bytes;
a detached digest hashes the manifest, avoiding self-reference. Equal bytes are
returned without rewriting; conflicts fail closed. New evidence for a sealed
incomplete snapshot needs a new cohort identity. Public-root rotation preserves
prior imports. Source reads and publication reuse fd-relative private Linux and
native protected-ACL/no-reparse Windows boundaries. Windows larger artifact reads
use a read-only lease; existing report write/read bounds remain unchanged.

## Bounded JSON is a security boundary

Report duplicate-key rejection, current-stream canonical-number validation and
historical/evidence decoding share `bounded-json.ts`. The scanner's cursor only
moves forward: no regex token search over escaped strings, no backtracking and no
CodeQL suppressions. It validates grammar, decoded duplicate keys, escapes/Unicode,
number lexemes, trailing data, byte/item/depth limits before decoding. JSON-valid
isolated UTF-16 surrogates are preserved; malformed escapes/UTF-8 are rejected.
Long escaped-quote/backslash cases have explicit cursor-step and time bounds.

New scanner/private-store/backfill/import/cohort suites must remain in both the
full test suite and the unconditional Windows regression matrix. Workflow command,
validator and negative probes move together. Local synthetic tests do not replace
private baseline reconciliation or clean exact-head CodeQL/Linux/Windows evidence.

Related: [durable current-run telemetry](/concepts/durable-run-telemetry.md),
[report-only correction](/concepts/report-only-format-correction.md).
