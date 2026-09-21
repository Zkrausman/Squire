# Current-run telemetry

```sh
squire telemetry aidev-299-0123456789
squire telemetry aidev-299-0123456789 --json --config /private/squire.json
```

This is a host-only, exact-run reader. It loads configuration and one private terminal artifact; it does not launch Pi, Git, Docker, credential commands, Linear or GitHub, inspect a checkout, poll with a model, or read `/ticket/sessions`. Missing artifacts (including legacy and active runs) return `available: false, complete: false`. Invalid/private-boundary violations return a sanitized error. The human view includes individual sessions, attempts, correction attempts, profiles, outcomes, Plan subphases, phase totals and run totals. `+unknown` denotes a subtotal, not a complete charge.

## Authority and isolation

Production launches use the pinned **Pi 0.84.4 `--print --mode json`** contract. The controller issues a UUID and exclusively seeds the Pi session header before launch. Requirements and Implementation Design each get a distinct UUID; their Plan supervisor compatibility journal is not a paid session. Report correction has a fresh isolated session outside the workspace, never an inherited Implement session. Its existing `no-session` report-envelope slot remains a compatibility identity, not the actual Pi artifact pathname.

Before dispatch, the host writes a closed invocation ledger binding run, phase/subphase, phase attempt, correction attempt, stage index/attempt, escalation-policy digest, initial/retry/stage-advance/remediation trigger, input Git head, profile, UUID, expected session-artifact path digest and start timestamp. The isolated Plan supervisor is also a trusted host process and writes to this same private per-run ledger; it does not send raw events to the controller IPC or model.

Only **exact child stdout bytes captured by the controller/supervisor command transport** can supply usage. They are copied to private host evidence, independently reread with identity/hash/length checks, and bound by the immutable end manifest. Model-writable session files are neither accounting authority nor reconciliation input: modifying, replacing or deleting them cannot affect totals. Do not import an old sandbox/session file as a capture. The authority assumes the pinned Pi runtime and host controller are trusted relative to the sandbox model/tools; it is not a provider-signed invoice or protection against host-administrator compromise.

Pi event streams contain private content. They are opaque protected evidence, **not telemetry output**. The report-evidence protocol now preserves the final structured assistant's text as the handoff artifact; raw stream evidence is retained separately. Existing strict handoff, Git, wiki, correction-fact, Review/Test and publication checks still apply. Accounting validation failures cannot cause a phase retry or turn accepted phase evidence into failure.

## Supported structured usage

Accounting consumes assistant `message_end.message.usage` only, never transcript text, tool-result usage, streaming deltas, `turn_end` repetitions or the repeated `agent_end.messages` list. The latter must reconcile exactly with the observed assistant sequence. The parser checks the version-3 session header/UUID, agent/turn/message ordering, unique provider response IDs (or exact-message digests when no ID exists), role, expected provider/model/API, completed stop reasons, final agent end and successful command termination. Error/aborted/pending/deferred or truncated streams are incomplete.

Supported provider/API pairs:

| Provider | Pi API |
| --- | --- |
| `openai-codex` | `openai-codex-responses` |
| `openai` | `openai-responses`, `openai-completions` |
| `anthropic` | `anthropic-messages` |

The four token dimensions are `input` (uncached), `output`, `cacheRead`, `cacheWrite`. Reasoning and one-hour cache-write breakdowns, if present, are validated as subsets and never added again. `totalTokens`, if present with all dimensions, must equal their sum. Each token dimension and its session sum is bounded to one trillion nonnegative safe-integer tokens. Missing dimensions are null; negative, fractional, unsafe, inconsistent and unsupported fields fail closed. All-zero usage on a content-bearing assistant is rejected because Pi's initial placeholder counters are not proof of zero provider use. Intermediate update usage is not authoritative or cumulative; only completed message usage is summed.

**Cost provenance matters:** `usage.cost.total` is preserved as **Pi-recorded USD**, not described as provider-reported billing. Pi may calculate that field using its runtime model rates; the JSON event does not establish an independent provider invoice. Provider-reported/invoiced cost is therefore unknown in this slice. Squire never looks up a current/historical price table, manufactures an estimate, or calls recorded Pi cost an invoice. Missing/invalid cost stays null/`unknown` even when tokens are known. Cost fields must be finite, nonnegative, bounded, closed and consistent with Pi's component sum (floating-point tolerance only for validating Pi's own total). Squire expands the recorded number to a bounded decimal and sums decimal integers at 24-place precision, without subsequent floating-point monetary arithmetic. No rounding or pricing lookup is used for totals.

Unknown providers, unsupported event variants (including compaction/retry protocol variants not covered by this parser), malformed JSON/UTF-8, duplicate JSON members/messages, bad identities, oversized or incomplete streams produce bounded allowlisted diagnostic codes, never copied provider content. Known subtotals in other sessions remain available. Missing or ambiguous invocation inventory conservatively marks all aggregate accounting dimensions incomplete.

## Durability, time and outcomes

Files are under `<paths.staging>/telemetry/<run-id>/`, outside the repository and sandbox:

- `<uuid>.start.json`: immutable pre-dispatch identity and wall-clock start;
- `streams/<uuid>.json`: opaque exact byte chunks, not necessarily JSON documents;
- `<uuid>.end.json`: independently verified chunk references and successful-command endpoint;
- invocation/phase outcome receipts: controller/supervisor observations, including superseded attempts;
- `summary.json`: the single additive terminal artifact.

Successful command-return time is the end boundary (Plan's root guard certifies remote child close). Failed/cancelled transports conservatively have a null endpoint because remote termination may not be proven. Duration is the nonnegative difference between persisted boundaries, not model timestamps or reconciliation time. Session sums are **invocation wall time**, including dispatch/transport overhead; run wall duration comes separately from persisted lifecycle start/end and includes non-model preparation/publication time. They need not equal each other. Missing endpoints are never filled with the current time.

Terminalization occurs after completed/failed/interrupted state persistence, best effort. Failure to publish, or incomplete accounting, produces a bounded persistence warning without changing the phase/run outcome or notification outbox. A crash before end publication leaves an incomplete session; a crash before summary publication leaves telemetry unavailable until the trusted current-run terminalizer reconciles its ledger. Restart reconciliation uses only this ledger and persisted lifecycle boundaries. Existing identical terminal artifacts are reused, never rewritten; conflicts fail closed. On Linux the trusted terminalizer can remove a proven same-inode private temporary link left by a crash between exclusive publication and temporary-name removal; the read-only CLI never performs repairs. The CLI does not initiate reconciliation or historical backfill.

The schema separates invocation `outcome` from `phaseOutcome`; the run-level `phaseOutcomes` map also preserves each logical phase’s latest accepted result (or explicitly unknown/not-run). An original malformed Implement handoff can remain `report-rejected` while its eventual corrected phase is `passed`; the paid correction is its own row. Remediation and escalation never replace prior session rows. A completed Squire run does **not** imply merged disposition or exact-head hosted CI success.

Linux uses private 0700 directories, 0600 ledger/summary files, no-follow fd-relative bounded reads and fsync + same-directory exclusive atomic publication. Raw evidence additionally uses immutable 0400 files, filesystem identities and hashes. Windows uses existing native local-NTFS owner/protected-DACL, no-reparse, retained-handle APIs for atomic exclusive publication and exact reads; Node mode bits are not a Windows security fallback. Publication is additive, not replacement of a historical file, so no unbounded Windows overwrite retry is introduced. Unsupported hosts/filesystems fail closed for accounting.

Bounds: 64 MiB captured stdout per invocation; 2 MiB independently verified raw chunks; 8 MiB per JSONL line; 200,000 events; 1,000 invocation rows; 2 MiB normalized ledger/summary documents. Command buffer overflow remains an execution failure, with available partial bytes retained as incomplete evidence. Telemetry adds no automatic deletion: retain the whole per-run telemetry directory with the private run evidence. Operators may remove the whole directory under their existing retention policy; that makes accounting unavailable, not zero. Never publish raw streams, manifests or private recovery bundles to a repository, PR, wiki, event stream or notification.

## Stable handoff API and deferred work

`RunTelemetry`, `TelemetrySession`, `TelemetryTotals`, `TelemetryInvocation`, `UsageAccounting`, `TelemetryStore.read`, `validateRunTelemetry`, `telemetryTotals` and `formatTelemetry` are exported from `src/index.ts`. `schemaVersion: 1`, `authority: pi-0.84.4-controller-json-v1` identify this authority model. Readers validate the closed normalized schema, exact run identity, bounded values, private storage and session-to-phase-to-run reconciliation before exposing output. Token/duration totals contain `known` and `complete`; recorded cost adds `source: pi-recorded`. Null session dimensions are unknown, not zero. Plan subphase totals are nested within Plan and must not be added to Plan again.

AIDEV-309 owns historical backfill, cohort comparison, baseline reproduction, exact-head CI/merge binding and scorecards. There is no arbitrary directory scan, historical rewrite or multi-run command here. Preserve pre-change artifacts and policy identities now. Future comparisons must select comparable gate classes, distinguish completed from merged tickets, retain retry/correction/infrastructure costs, disclose missing accounting and small sample sizes, and avoid causal model-quality claims. Telemetry does not authorize retries or change context, model-selection, remediation-budget, Review/Test or merge policy.

## Checks

Parser, private-store and production-controller fixtures cover the six-session run, remediation, staged profiles, report correction, interruption, unknown endpoints/cost, malformed/duplicate/unsupported streams, privacy and session-file tampering. They run in the normal suite and the existing bounded unconditional Windows launch matrix. Workflow commands, executable validator expectations and negative probes must change together; Linux tests do not replace the exact-head Windows gate.

## Transient launch generations

[Transient launch recovery](transient-launch-retry.md) adds optional
`launchGeneration` (1 or 2) to invocation/session rows without changing the logical
`attempt`. Legacy v1 artifacts without it remain valid. The failed launch and
retry are separate immutable UUID rows; the retry trigger is `retry`. Modern
inventory reconciles exact dispatched ledger sessions, paths and HEADs rather
than requiring exactly one row per phase attempt. A reserved-but-undispatched or
missing row leaves accounting incomplete. Supervised Plan still inventories its
two children, not the aggregate journal.

The Daybreak error has an observed process endpoint and `execution-failed`
outcome, but zero placeholder usage is not a provider bill: its charge remains
unknown. Recovery adds the gate launch/retry rows only; accepted Plan and
Implement add no extra time/token/cost rows. Cohort consumers should compare the
same logical gates, retain infrastructure costs and missing dimensions, and not
infer a paid replay or a zero-cost failure from session count alone.
