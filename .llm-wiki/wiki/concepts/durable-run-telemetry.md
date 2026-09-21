---
type: concept
domain: engineering
confidence: high
---

# Durable current-run telemetry

The personal controller's accounting authority is pinned Pi 0.84.4 **structured child stdout captured by the trusted host**, not model-writable `/ticket/sessions` JSONL. Every model launch has a controller-issued UUID, pre-dispatch identity/start ledger, protected exact-byte stream evidence and a terminal receipt beneath `<paths.staging>/telemetry/<run-id>`. Requirements and Implementation Design are separate paid sessions; the Plan aggregate journal is not. Report correction has a fresh isolated session, never an inherited Implement session.

`message_end` assistant usage is counted once after validating session/provider/model/API identity, event ordering, finality, bounded safe token values and unique message identity. `message_update`, `turn_end`, `agent_end` copies, transcript text and tool-result usage are not additional charges. Unsupported, malformed, duplicated, interrupted or missing evidence fails closed for accounting without changing phase gates or retries. Four token classes stay separate. Recorded Pi cost uses exact decimal summation and is explicitly **Pi-recorded**, not provider-invoiced; Pi may derive it from runtime rates. Squire performs no pricing lookup or estimate, and absent provider billing remains unknown.

The immutable version-1 `summary.json` has per-session attribution, separate invocation/accepted-phase outcomes, phase/subphase totals, run totals and dimension completeness. An original report-rejected invocation can later belong to a passing corrected phase; its correction remains another paid row. Every remediation/staged attempt retains its actual profile, stage and trigger. An incomplete invocation inventory makes aggregate dimensions incomplete rather than implying complete subtotals.

Durations derive only from persisted host dispatch/observed successful-command boundaries. Unproven remote termination has a null endpoint; reconciliation never fabricates one. Summed invocation wall time differs from lifecycle run wall time. Additive publication uses existing Linux fd-relative/private/fsync and Windows native local-NTFS ACL/no-reparse boundaries. Raw streams are private opaque evidence and may contain model/tool content; normalized artifacts and the CLI never expose that content. Retain/remove telemetry with private run evidence, never copy raw capture into repository material or the notification outbox.

`squire telemetry RUN-ID [--json] [--config FILE]` is a single-run host-only artifact reader without external adapters or mutable-session inspection. Legacy/missing artifacts explicitly report unavailable/incomplete; unsafe artifacts fail with sanitized errors. Terminal accounting warnings do not relabel accepted workflow evidence. The typed reader/validator and versioned artifact are exported for AIDEV-309, which owns backfill, cohorts, baseline reproduction and merge/CI scorecards. Squire completion is not a merge or exact-head CI claim.

Implementation and authority details: `src/personal/telemetry-{capture,stream,store}.ts`, `pi-phase-runner.ts`, `plan-supervisor.ts`, `controller.ts`, and [docs/telemetry.md](../../../docs/telemetry.md). The three telemetry suites run in the ordinary tests and the bounded unconditional Windows gate. Keep workflow test commands, executable validator expectations and negative validator probes in lockstep.

## Launch generations

`launchGeneration` is optional additive invocation attribution (legacy rows omit
it), separate from logical/staged attempts and correction attempts. Inventory
reconciles every dispatched generation with UUID, expected HEAD and session-path
digest. Failed and replacement launches retain independent outcomes/cost/time;
accepted Plan/Implement rows are not replayed to recover Review availability.

The closed Daybreak launch rule permits explicit recorded zero usage/cost and an
observed command-failure endpoint for its complete empty error turn. Unknown or
ambiguous failures remain incomplete; pre-spawn failures have no Pi billing to
invent. This narrow exception does not make arbitrary error streams authoritative.
Accounting warnings remain diagnostic-only after completion and cannot trigger
another ticket fetch or launch. See [Transient phase-launch retry](transient-phase-launch-retry.md).
