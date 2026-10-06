# Factory reliability research

Source audit: 6 October 2026, based on Squire [ec98a61](https://github.com/Zkrausman/Squire/commit/ec98a61bd6a0fec89246c0b160ca90d2ff363d68). These documents support the [roadmap](../roadmap/README.md); they are proposed engineering contracts, not a claim that new behavior has shipped.

## Read in this order

1. [Recovery and delivery hardening](factory-recovery.md): external-operation identity, candidate commit recovery, immutable artifacts, budgets, execution preflight and exact delivery receipts.
2. [Acceptance and evidence hardening](factory-acceptance.md): criterion-to-proof resolution, real browser/native observations, origin versus acceptance, and a future controlled Pith comparison.

Use the existing SQLite store, process supervisor, workspace and delivery adapters. The goal is less owner reconstruction after an interruption and a truthful result with inspectable evidence, not a new general-purpose orchestration platform.

## Evidence vocabulary

| Label | Meaning in these documents |
| --- | --- |
| Implemented facility | Observed in pinned source. This is not by itself an execution result. |
| Existing fixture | Test source exercises a named boundary. CI evidence belongs to its exact commit; it does not prove live-model or application outcomes. |
| Static risk | A plausible failure path inferred from source order or missing correlation. Not a reproduced bug. |
| Proposed fixture | An unexecuted failure-injection or negative case intended to validate a future change. |
| Proposed acceptance contract | A requirement for future behavior. A schema alone does not prove it is enforced. |
| Live/integrated result | A separately observed outcome tied to the actual candidate, environment, configured checks and authority. State missing layers explicitly. |

Use candidate head/tree, physical job ID, logical attempt, operation ID and immutable receipt consistently. A physical dispatch can consume a call reservation without completing a logical implementation attempt; changing that accounting requires a versioned new-run policy and must not rewrite old evidence. A retained receipt states what was observed, not permission to skip newer gates.

## Dependency map

- R0 and A1: source/status and provenance design.
- R1 precedes R2 and R3: registered process reconciliation before candidate journaling and immutable job evidence.
- R2/R3 support R4 result/budget recovery and R5 exact delivery receipts.
- R1/R3 support R6 execution-boundary readiness.
- R3 supports A2 immutable acceptance references; A2 plus trusted admission supports A3 criterion enforcement.
- R4-R6 support R7's separately authorized demonstration. A2/A3/R6 support A4's first real browser producer when the task needs it.
- A5 prepares a report/protocol. Any effectiveness trial still needs a separately authorized, completed and independently graded baseline; Pith adds its output-fidelity prerequisite.

Slices are deliberately small. Shared manifest/identity fields should have one implementation, with the recovery document owning retention and the acceptance document owning evidence admissibility. “Proof” in a slice name means evidence satisfying a declared criterion, not a universal correctness or security guarantee.

## Historical results and execution hold

The [v0.1 closure record](../releases/0.1/baseline-closure.json) preserves a closed-incomplete original baseline and separately accounted, unscored manual harness completion. It records the owner hold on benchmark/comparative execution. Keep the earlier archive snapshots unchanged, even where their historical text says work was in progress.

This research did not run providers, benchmarks or the new proposed fault fixtures. Ordinary repository CI on a documentation PR verifies the unchanged controller suite separately. Publishing the designs does not authorize implementation, live demonstrations, new budget admissions or benchmark runs.

## Open design decisions

Before implementation, settle the narrow operation-journal schema, affirmative evidence for any quota attempt exemption, supported host process identity, criterion-to-evidence mapping and the first task's execution profile. Before comparisons, freeze the protocol, admissible observations, repetition plan and promotion rule. The documents identify these choices without claiming they are already resolved.
