---
type: concept
domain: engineering
confidence: high
---

# Controller-owned current-run telemetry

The personal runtime's accounting authority is the Pi child process **JSON event pipe captured by the host controller/trusted Plan supervisor**, never `/ticket/sessions`. Model/tool-writable session JSONL cannot substantiate token or cost claims. Controller staging/state directories must remain outside the repository and sandbox; raw telemetry objects are never copied into the model workspace.

All model launches, including Plan children, remediation/staged attempts and report-only correction, have distinct controller channel/session identities and lifecycle rows. Pi header UUIDs are a separate namespace, bound to the launch rather than assumed equal to controller IDs. Provider/model echoes must agree with the resolved invocation; thinking comes from controller policy because the stream does not reliably echo it. Plan sends launch and close rows over trusted IPC, preserving an interrupted child when a supervisor disappears. The deterministic supervisor compatibility journal is not a paid model session. Requirements and Implementation Design remain separately visible under one Plan total.

Only supported final assistant `message_end` usage contributes. The version-3 Pi print JSON contract supports `openai-codex/openai-codex-responses`, `openai/openai-responses` and `anthropic/anthropic-messages`. Partial updates and turn/agent-end replays are not additional usage. Schema, identity, profile, numeric bounds, ordering, finality and duplicate failures discard that session's accounting claim with fixed diagnostic codes. Reports are independently extracted from structured terminal assistant content and still face normal strict controller/gate validation; telemetry faults cannot authorize retries, repair reports, or relabel successful phase evidence.

**Pi normalized `usage.cost` is calculated from model rate tables, not provider billing.** This artifact version does not accept it as provider-reported money or add estimates. `providerCost` is null/unknown even when Pi emits numeric costs or zero. Complete token/duration coverage can therefore coexist with incomplete overall accounting. Cache-read/write remain distinct from normalized uncached input. Future monetary support needs a documented authority source and versioned exact-decimal contract, not a mutable rate lookup relabelled as billing.

## Durable boundary and reader

- Append-only launch/close objects and exact stream byte chunks live in private `<paths.staging>/telemetry-evidence`. Raw bytes can contain private task/source/model content and never appear in summaries, notifications or telemetry command output.
- Production JSON capture keeps a bounded exact prefix and a separate bounded latest event. Accounting overflow drains the child instead of killing paid work; a valid terminal report can still complete while accounting is explicitly incomplete. Bounds are 64 MiB per captured stream/event, 200,000 events, 10,000 assistant completions, 100 nesting levels, 1,024 summary sessions and 2 MiB per private evidence object/summary.
- Terminalization publishes an immutable summary under `<paths.state>/telemetry`. The existing atomic state CAS commits its identity/hash/length reference, terminal revision and completeness. Fully written/fsynced unreferenced objects are not publications. Identical terminal requests are idempotent; orphan/temporary files are never scanned or promoted. Publication failure records bounded unavailability without changing the run's outcome.
- Linux reuses pinned no-follow, current-UID/private-mode, one-link and identity/digest checks. Windows reuses native protected local-NTFS owner/DACL/reparse/lease validation and existing atomic state replacement. There is no mode-bit or unsafe filesystem fallback.
- Session time is persisted controller wall time around dispatch/local transport close, not inferred provider latency. Missing/reversed endpoints stay unknown. Known session-duration sums and run start-to-terminal wall time are different measures. Per-session reported/correction outcomes remain separate from accepted logical-phase and run outcomes.

`squire telemetry RUN-ID [--json]` reads config, state and the bound validated summary only—no repository inspection, Pi, Docker, credentials, transcripts, live mutable sessions or historical scan. `squire status` displays the bounded accounting disposition. Totals are known-session subtotals with explicit completeness; retries remain rows rather than disappearing when latest state results overwrite older attempts. The notification outbox is unchanged.

The stable typed `RunTelemetry` / `TelemetryReadResult` / `readRunTelemetry` API validates closed shapes, terminal binding, expected attempts/profiles, duplicate identities and exact totals. Legacy/active runs without a terminal reference are unavailable/incomplete. A hard crash may leave a private launch journal and unreferenced objects but no terminal artifact; that is not a resumable checkpoint and does not fabricate elapsed time or spend.

No automatic retention deletion, historical rewrite, cohort reporting or CI/merge inference is introduced. AIDEV-309 owns additive backfill, cohort/scorecard comparisons and provisional-baseline reproduction. Preserve pre/post-change evidence and disclose cost/accounting completeness and small samples; completion is not merge. Linux tests are not proof that hosted Windows exact-head gates passed.

Implementation: `src/personal/{pi-telemetry-parser,telemetry,command,pi-phase-runner,plan-supervisor*,controller,json-run-state,cli}.ts`. Authority/retention/operator details: `docs/telemetry.md`. Synthetic parser, transport, controller, store and CLI contracts: `test/personal-telemetry*.test.ts`.
