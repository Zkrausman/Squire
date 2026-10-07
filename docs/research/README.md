# Factory reliability research

Source audit: 6 October 2026, based on Squire [ec98a61](https://github.com/Zkrausman/Squire/commit/ec98a61bd6a0fec89246c0b160ca90d2ff363d68). These documents support the [roadmap](../roadmap/README.md); they are proposed engineering contracts, not a claim that new behavior has shipped.

## Read in this order

1. [Recovery and delivery hardening](factory-recovery.md): external-operation identity, candidate commit recovery, immutable artifacts, budgets, execution preflight and exact delivery receipts.
2. [Acceptance and evidence hardening](factory-acceptance.md): criterion-to-proof resolution, real browser/native observations, origin versus acceptance, and a future controlled Pith comparison.
3. [Execution-boundary preflight](factory-runtime-preflight.md): expands R6 into zero-model admission, exact-policy capability receipts, bounded workspace/Git/tool/lifecycle/export probes, and truthful invocation/progress status. P0-P5 are R6's smaller slices, not another scheduler or acceptance framework.
4. [Bounded skill improvement](factory-skill-improvement.md): one advisory implementation-skill, immutable recipe identity, separate training/selection/final holdout, privacy-safe feedback, whole-campaign accounting and independent promotion/rollback. S0-S3 cover design and a proposed zero-model fixture; S4-S5 require a future authorized baseline and trial.
5. [Operator visibility and decisions](factory-operator-workflow.md): a passive CLI projection of activity, durable progress, pending results and root decisions; explicit observation gaps and an optional quiet, replay-safe notification sink. O0-O5 reuse recovery, acceptance and P5 rather than replacing their ownership. This memo audits main at `3a0f921`; its interfaces and fixtures remain proposed.
6. [Trust and privacy boundaries](factory-trust-boundaries.md): process environments, untrusted diagnostic authority, artifact/path integrity and destination-specific disclosure. T0-T3 reuse R3/A2/P-series/O-series contracts; the memo audits main at `28b14ab7` and documents static risks and proposed controls, not reproduced vulnerabilities or delivered security fixes.
7. [Delivery benchmark portfolio and readiness](factory-benchmark-portfolio.md): four exposed Go/Node development archetypes and an optional generic desktop case, independent future holdout selection, zero-model validity controls, all-assignment failure/cost reporting and small-sample limits. BP0-BP4 reuse the existing descriptors and R/P/A/T gates; no fixtures, holdout selection or campaign execution is supplied or authorized.

Use the existing SQLite store, process supervisor, workspace and delivery adapters. The goal is less owner reconstruction after an interruption and a truthful result with inspectable evidence, not a new general-purpose orchestration platform.

For choosing what to work on next, use the [value/effort selection method and qualitative shortlist](factory-value-prioritization.md). Rank complete eligible outcomes at decision boundaries, include full remaining verification and owner effort, and stop research once the next decision is supported. This planning rule changes neither the dependencies nor the execution hold below.

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
- R1/R3 support R6 execution-boundary readiness. Its P0/P1 schema and pure resolver precede P2's one supported probe route and P3's pre-reservation dispatch gate; P4 (GUI/IPC capability, also requiring A2) and P5 (status correlation) follow P3.
- R3 supports A2 immutable acceptance references; A2 plus trusted admission supports A3 criterion enforcement.
- R4-R6 support R7's separately authorized delivery/recovery demonstration. An R7 claim of version-2 criterion acceptance additionally requires A2/A3; otherwise label criterion acceptance pending. GUI/native claims require the task-specific producer and actual candidate observations. A2/A3/R6 support A4's first real browser producer; its synthetic fixture would establish the pipeline only.
- A5 prepares a report/protocol. Any effectiveness trial still needs a separately authorized, completed and independently graded baseline; Pith adds its output-fidelity prerequisite.
- Skill S1/S2 reuse R3 recipe/evidence identity, A2/A3 acceptance and A5 reporting; S3 specifies the bridge and uses R1-R4/R6 wherever physical jobs would occur. S4/S5 additionally require explicit execution approval and the independently graded larger-benchmark baseline. Neither GEPA validation nor controller CI is an untouched final holdout or a Squire effectiveness result.
- Operator O1/O2 start from existing state/events with explicit unknowns. O3 consumes R1/R3 and P5 observation identities, adding R2/R5/A2/A3 only for stronger result claims. O4 is optional and requires an authorized destination/policy; O5 needs a separately admitted owner task. These slices add presentation and decision/delivery lifecycle, not another recovery or benchmark-status implementation.

- Trust T1 reuses P0/P1 process-profile identity; T2 extends the R1/R3 collector/reader and A2 references; T3 constrains existing repair/publication paths and O-series exports before an optional sink. Environment filtering, candidate hashes and local file modes do not establish hostile same-user code isolation.

For the first non-GUI route, R6 means the applicable P0-P3 admission path. P4 and real browser/native producers are required only for the selected task's capability/acceptance claims; P5 is required for benchmark invocation/progress correlation claims. O0's reference to the P5 design does not require P5 implementation, and O1/O2 can report explicit unknowns. Design references do not make every downstream implementation a prerequisite; no required capability, acceptance or safety gate becomes optional.

Slices are deliberately small. Shared manifest/identity fields should have one implementation, with the recovery document owning retention, the acceptance document owning evidence admissibility, the preflight document owning boundary-scoped readiness, and the skill document owning candidate text/lineage, split identity, feedback export and future-job selection. P4's inert browser fixture does not replace A4's real application acceptance. “Proof” in a slice name means evidence satisfying a declared criterion, not a universal correctness or security guarantee.

## Historical results and execution hold

The [v0.1 closure record](../releases/0.1/baseline-closure.json) preserves a closed-incomplete original baseline and separately accounted, unscored manual harness completion. It records the owner hold on benchmark/comparative execution. Keep the earlier archive snapshots unchanged, even where their historical text says work was in progress.

This research did not run providers, benchmarks or the new proposed fault fixtures. Ordinary repository CI on a documentation PR verifies the unchanged controller suite separately. Publishing the designs does not authorize implementation, live demonstrations, new budget admissions or benchmark runs.

## Open design decisions

Before implementation, settle the narrow operation-journal schema, affirmative evidence for any quota attempt exemption, supported host process identity, criterion-to-evidence mapping and the first task's execution profile. That profile must establish exact sandbox-helper policy parity, bounded cleanup/export and required browser sandboxing; unknown capability blocks rather than selecting a weaker route. Before comparisons, freeze the protocol, admissible observations, repetition plan and promotion rule. Skill trials also need a measured instruction-addressable bottleneck, exact skill interface, independently controlled holdout, authorized proposer route and full campaign budget. The documents identify these choices without claiming they are already resolved.
