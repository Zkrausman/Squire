---
type: concept
domain: engineering
confidence: high
---

# Historical telemetry and cohort scorecards

`squire cohort SPEC --trust-roots ROOTS [--config CONFIG]` is a host-only,
explicit-run, import-only workflow. It does not discover runs, query services,
launch models, sign evidence, modify policies or weaken delivery gates. Canonical
JSON artifacts are additive/content-addressed under the configured private data
root's `cohort-artifacts` directory; no state/session/telemetry inputs are rewritten.

Three authorities remain distinct: validated persisted state establishes Squire
completion and attempt chronology; current controller-captured telemetry establishes
current usage; independently authenticated exact-head disposition establishes CI,
merge and optional reopen outcomes. Retained Pi v3 session assistant usage is only
**provisional historical evidence** bound by file digest and header session UUID.
It never becomes `RunTelemetry`. Current and historical usage for a run are not
added together. Historical baseline reconciliation always uses historical rows.

Disposition manifests use canonical exact UTF-8 bytes (sorted keys, ordered arrays,
no duplicate keys/BOM/whitespace/newline, safe integers or decimal strings), SHA-256
identity and detached Ed25519 signatures. Operator public roots live outside all
repositories and support exact key-ID rotation, signer binding, revocation and
validity at signed-at time. Digests alone are not authentication. Private signing
keys and signing commands are never accepted by Squire. Invalid/unbound/unsigned
imports retain unknown CI/merge and bounded sanitized diagnostics, while usage
reconciliation continues.

Gate comparability requires repository, required-check-set, ticket class and
materially equivalent Review/Test/publication gates. Baseline, workflow, profiles,
escalation/correction policies and suite remain visible strata. Scorecards separate
side, full stratum, phase/profile/outcome and accounting authority; heterogeneous
tickets are exposed rather than silently pooled. All samples are descriptive,
with no causal model-quality claim.

Metric rule `cohort-v1` preserves ticket denominators, unsuccessful fresh runs,
unmerged costs and explicit unknowns. First-pass acceptance requires first candidate,
first Review/Test and exact-head CI. Cost per merged ticket retains enumerated runs
through verified merge; uncertain boundary allocations stay unknown. Wall time spans
first reservation through merge and differs from active invocation time. Report and
infrastructure waste require signed rule-versioned classifications referencing the
current session's stream digest; generic failure is not waste evidence. Historical
session inventory and all-ticket-run inventory cannot be proven from explicit lists,
so known subtotals are not advertised as complete totals.

Private baseline targets carry the operator artifact digest/extraction identity,
expected totals and exact run selection. Reconciliation emits observed historical
totals, deltas and bounded variance reasons without inventing missing evidence or
trust. Real identifiers, session paths, prompts, baseline evidence and keys must not
enter repository fixtures; tests use synthetic records and ephemeral signing keys.

Linux byte storage uses private fd-relative no-follow stable reads and atomic
exclusive/fsync publication. Windows uses native protected ACL/no-reparse handles
and exact Buffer reads (not lossy UTF-8 conversion). The bounded unconditional
Windows gate includes the cohort evidence, scorecard and store regression suites.

See [current telemetry authority](durable-run-telemetry.md),
[operator schemas and metric semantics](../../../docs/cohort-scorecards.md), and
`src/personal/{canonical-json,cohort-domain,disposition-evidence,historical-telemetry,cohort-scorecard,cohort-store,private-artifacts}.ts`.
