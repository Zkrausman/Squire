# Current-run telemetry

```sh
squire telemetry aidev-299-0123456789
squire telemetry aidev-299-0123456789 --json --config /private/squire.json
```

This is a read-only, exact-run command. It reads configuration, persisted run state and the state-bound telemetry artifact only. It does not start Pi, Docker, Git, a credential helper, or a model; inspect a repository; read `/ticket/sessions`; or scan historical/raw session directories. Ticket selectors, multiple run IDs and backfill/cohort switches are not accepted. Human output shows sessions, attempts, profiles, outcomes, durations, four token categories, separate Requirements/Implementation Design rows, logical phase totals and run totals. JSON returns a versioned typed summary inside an `available` result, or a bounded `unavailable`/`incomplete` diagnostic. `status` also shows the persisted accounting disposition, not raw evidence paths.

**Cost is currently unknown, not zero.** Supported Pi normalized `usage.cost` values are calculated from Pi model rate tables, not provider billing records. They are deliberately **not** promoted to provider-reported money. This delivery does not estimate prices. Consequently a run can have complete token/duration accounting while overall accounting remains incomplete because provider cost is unavailable. This applies even when Pi emits a numeric zero cost. It is an intentional authority distinction, not a billing estimate.

## Authority and binding

Every personal-runtime model invocation uses Pi print **JSON event mode**, including both supervised Plan children, flat legacy-policy Plan, Implement, Review, Test, Retro, remediation/staged attempts and report-only correction. A deterministic Plan supervisor journal is not a model session and is not counted.

The host controller (or its trusted, separate Plan supervisor subprocess) captures child stdout directly over its process pipe. Host evidence is never copied into the sandbox. It is **not** read from model/tool-writable session JSONL. Editing, replacing or deleting `/ticket/sessions` cannot change captured accounting. Session JSONL is not used even as reconciliation input in this version.

Each launch has a controller-generated channel ID and session/producer ID, canonical session-artifact identity (null for no-session correction), run, phase/subphase, attempt, resolved provider/model/thinking, and controller-observed start/end. Pi's separately generated session-header UUID is bound to that launch channel; it is not assumed equal to the controller's session ID. Reused Pi header identities within a run lower completeness. Provider/model echoes must match the launch profile. Thinking is bound to the controller invocation, since Pi events do not echo a reliable thinking profile. Stage index/attempt/policy digest and remediation attribution remain visible; superseded results do not remove earlier sessions.

Plan IPC sends bounded launch and close metadata separately from model results. A controller that observes a launch but loses the supervisor retains an interrupted, open-ended row, not a fabricated completed session. Requirements and Implementation Design remain individually visible; clarification ends Requirements as `needs_clarification`. Invalid telemetry metadata degrades accounting without becoming a model phase result or changing valid Plan evidence.

### Supported records

The parser implements the Pi print JSON contract with a version-3 `session` header, `agent_start`, turns, message start/update/end, tool events and one final `agent_end`. The reference contract is `@mariozechner/pi-coding-agent`, `pi-agent-core` and `pi-ai` 0.73.1 (`modes/print-mode`, agent events, and normalized assistant usage). There is no dependency on these packages in the host controller and no provider call in the tests. Other contract/provider variants fail closed for accounting, rather than being heuristically scraped.

Supported provider/API pairs:

| Provider | Pi API | Accepted normalized usage |
|---|---|---|
| `openai-codex` | `openai-codex-responses` | `input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens` |
| `openai` | `openai-responses` | same |
| `anthropic` | `anthropic-messages` | same |

Only final assistant **`message_end`** usage contributes. Partial `message_update` usage, tool output, user text and the replays in `turn_end`/`agent_end` never contribute additional tokens. Replayed final messages must agree exactly. Duplicate messages/completion timestamps/response IDs, duplicate JSON keys, invalid ordering, non-final/error/aborted streams, schema/profile mismatches, missing fields and unsupported providers invalidate that session's token claim. Tokens are safe nonnegative integers, bounded to 10^12 per category/session; `totalTokens` must equal the four categories. Aggregate safe-integer overflow is rejected. `input` is Pi's normalized uncached input; cache read/write remain separate and are never added into that input column.

Assistant `usage.cost` is schema/bounds/consistency checked if present, but **never accepted as provider-reported cost**. Pi's `calculateCost` and provider service-tier adjustments use model pricing metadata. Version 1 therefore has `providerCost: null` and explicit cost completeness, without an estimated-cost or misleading known-dollar subtotal. An adapter for genuine provider-billed amounts would need a documented provenance contract and versioned exact-decimal representation before those amounts could be aggregated.

Phase reports are extracted from the last structured `agent_end` assistant's text, not from terminal presentation or transcript text. Their existing strict report, HEAD, wiki, correction and independent-gate validation remains unchanged. Accounting validation is separate: bad usage can coexist with a valid phase result. Accounting-only malformed/duplicate members cannot repair or invalidate an otherwise unambiguous report. An absent/ambiguous/truncated terminal report still fails the existing handoff gate.

## Bounds, persistence and restart

- Each child stream has a 64 MiB exact-byte capture budget. The production transport **drains**, rather than kills, a child after accounting overflow. It separately retains the most recent complete event (also bounded to 64 MiB), so a later valid terminal report remains usable. A truncated accounting prefix is marked incomplete with `stream_limit`; its values are not counted. No child stderr or decoded event text is included in transport error messages.
- Parsing is bounded to 200,000 events, 10,000 assistant completions and 100 nesting levels. The summary has at most 1,024 sessions and fits the existing 2 MiB private evidence-object bound. Diagnostics are fixed codes, not exception/provider text.
- Append-only launch/close records and exact byte chunks (each at most 2 MiB) live in `<paths.staging>/telemetry-evidence/`. Close records bind the captured chunks to the channel and lifecycle. Launch persistence is attempted before dispatch (failure is marked incomplete); closes retain failed/interrupted calls as well as successful calls. An overflow record describes the exact captured prefix, not the uncaptured remainder. Raw events can contain private task/source/model content: **they are private evidence, never reporting output**.
- At terminalization, the controller reconciles ledger identities/counts/profiles against state and publishes an immutable summary object in `<paths.state>/telemetry/`. State receives an additive `telemetry` disposition with terminal revision, completeness and a private object identity/hash/length reference. Bootstrap failures publish an empty-session summary where possible; publication errors yield a bounded unavailable disposition without changing the underlying terminal outcome.
- Publication uses the existing protected evidence backend, followed by the normal atomic run-state CAS. Objects are fully written/fsynced before their references are committed; the state reference is the atomic publication point, not directory enumeration. Identical publication requests reuse the same object. A failed CAS can leave an unreferenced object; readers never promote or scan it. Once state binds a disposition, normal updates cannot replace it.
- Linux uses current-UID-owned mode-0700 evidence directories, mode-0400 immutable evidence objects, pinned descriptors, no-follow reads, one-link/owner checks, and filesystem identity plus digest verification. Windows uses the existing native local-NTFS protected owner/DACL, ancestor/reparse, identity and exact-read primitives, not POSIX mode-bit emulation. State replacement keeps the existing Windows rename/share retry boundary. Unsupported private storage has no unsafe fallback.
- A reader validates the exact object reference, run/terminal revision/outcome/endpoints, closed schema and recomputed totals/attribution. Replacement, symlinks, wrong digest/run, partial files, and stale temporary files cannot become authoritative reports. Reads never rewrite state or evidence.

A hard controller crash can leave a launch record without a close and state without a terminal reference. There is no new resume/recovery policy: such an active/legacy run reports unavailable/incomplete. Missing endpoints are never reconstructed from transcript timestamps or current time. Successful terminal references remain deterministic across process restarts. Unreferenced partial/orphan objects remain private evidence, not resumable acceptance checkpoints.

### Duration and completeness

Session duration is the nonnegative integer difference between persisted controller wall-clock observations around launch dispatch and local child-transport close, including launch-record/transport overhead but excluding subsequent report validation, Git checks and publication. It is not provider inference latency or a claim of remote sandbox quiescence. Plan's existing remote guard still independently observes termination. Clock reversal or a missing end produces unknown duration, not a clamped/inferred value.

Phase/run session-duration totals sum known row durations. Whole-run wall duration separately spans persisted run start to terminal end; preparation, control overhead and publication make it different from summed model-session time. The terminal observation predates telemetry publication/state-file I/O itself.

Token totals are **known-session subtotals**, with completeness flags. Invalid/partial sessions contribute no fabricated zeros; their token fields are null and the subtotal is marked partial. Missing launch identities, profiles or expected attempts lower aggregate completeness. Per-session terminal outcomes are separate from logical-phase and run outcome; a report-correction session has its own row and accepted/failed disposition while the original malformed report stays visible. Run `completed` does **not** assert exact-head external CI or merge.

## Retention and comparisons

No automatic deletion or historical rewrite is introduced. Summaries, raw capture objects, launch/close journals and existing report evidence follow the private run-data retention boundary. Operators must apply the same restricted backup/retention policy as private Squire state. Deleting raw evidence does not change an already committed summary, but removes future audit/reconciliation material. Deleting/replacing a referenced summary makes telemetry unavailable. Do not copy raw evidence into repositories, tickets, notifications or model prompts. The bounded notification outbox is unchanged and receives no telemetry records or paths.

Embedders constructing `SandboxPiPhaseRunner` must pass `telemetryStateDirectory` matching their run-state store; older staging-only construction remains functional but explicitly reports unavailable instead of guessing a publication root.

The exported `RunTelemetry`, `TelemetryReadResult`, `readRunTelemetry`, validators and totals API in `src/personal/telemetry.ts` form the versioned reader boundary for AIDEV-309. Existing legacy state remains readable but is explicitly unavailable; no arbitrary retained sessions are scanned. Historical backfill, selected-run cohorts, merge/CI disposition binding and reproduction of the private provisional baseline are deferred to AIDEV-309. Before evaluating a future policy change, retain comparable pre-change/post-change runs and disclose token/duration/cost completeness and sample size. Do not treat an unknown dollar amount as zero, infer merge from completion, or claim model-quality causality from small samples.

Offline tests cover parser adversaries, actual-process bounded capture, normal six-session supervision, remediation/staging, interruption, correction, publication/capture failure, privacy, immutable reads, and Linux/Windows storage contracts. Hosted Windows exact-head CI remains required; Linux success alone is not Windows execution evidence.
