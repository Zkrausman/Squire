---
type: concept
domain: engineering
confidence: high
---

# Transient phase-launch retry

The personal controller, not the model, owns at most one replacement **launch
generation** inside one logical phase attempt. `launchRetryPolicy.maxRetries`
defaults to 1 and can only be lowered to 0. Raw/effective policy is bound into
immutable launch material and run state. Prior accepted phases, candidate HEAD,
profile/stage, remediation counters, sandbox and prompt/input snapshot do not
change. The original monotonic deadline covers both generations and report
correction; fixed 1,000 ms backoff is cancellable and cannot extend it.

`pre-result-provider-v1` is closed adapter authority. The initial provider rule
requires a complete pinned Pi JSON error turn for the exact Daybreak Blue access
verification message: matching session/provider/model/API, no assistant content,
response ID, tools or updates, and explicit zero usage/cost. A second rule accepts
OS `EAGAIN` only when no process/PID/output was created, translated by the runner
only around the actual phase invocation. Unknown stderr/text, hard auth,
moderation, malformed reports, ambiguous timeouts, implementation/tool failures,
ticket fetches, state writes and accounting warnings are never retry authority.
The controller additionally requires no result/progress and independently verifies
cleanliness and unchanged expected HEAD. Missing proof fails closed. The runtime
has no authoritative per-call token/cost ceiling; no new cost allowance is created.

`launchGenerations` records append-only reserved/dispatched/failed/retrying/returned
boundaries, immutable session/path identities, input digest, expected HEAD,
deadline, classifier/rule, bounded error code and elapsed delay. Generation zero
retains legacy unsuffixed paths; generation one uses `-g1` paths and a fresh UUID.
Logical-input hashing excludes generation/report-session identity; captured launch
evidence separately binds config/prompts. Host input creation and sandbox input/
session reservation are exclusive, and failed collision cleanup never deletes
another writer's input. Each invocation receives detached input data.

Production JSON saves fence each ledger append with ticket reservation ownership,
the ticket operation and version CAS. Dispatch follows its own durable commit.
Stale controllers cannot reload and dispatch; a returned record is not acceptance.
There is no automatic takeover/resume of an interrupted run, even from a reserved
boundary. Crashes require human inspection; terminal repair, reservation theft,
replaying earlier phases and promotion of failed candidates remain forbidden.
Supervised Plan progress/results remain a separate protocol, not retry permission.

Status distinguishes `retry_backoff` from `model_work`. Bounded `launch_*` events
have generation-aware semantic identities for outbox reconciliation; diagnostics,
raw provider responses, credentials and prompts stay out of events. Telemetry has
separate failed/replacement invocation rows and generation-aware inventory checks;
missing accounting remains additive, never a workflow trigger or ticket refetch.

Authority: `src/personal/launch-retry.ts`, `controller.ts`, `json-run-state.ts`,
`pi-phase-runner.ts`; [personal operations](../../../docs/personal-mvp.md).
Regressions: `test/personal-launch-retry.test.ts`, combined with launch-material,
controller, telemetry and report-correction in the unchanged bounded Windows
Node 24-only matrix ([prospective policy](/concepts/node-runtime-support-policy.md)). Linux fixtures do not replace exact-head Windows gates.

Related: [Durable telemetry](durable-run-telemetry.md),
[Windows launch capture](windows-launch-capture.md).
