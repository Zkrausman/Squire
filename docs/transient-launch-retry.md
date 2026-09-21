# Transient phase-launch recovery

Squire can relaunch an unavailable provider **inside the current logical phase
attempt**, without replaying accepted Plan/Implement work or consuming a staged
model-result retry/remediation slot. This is not failed-run recovery, provider
failover, model ranking, report correction, or corrective delivery.

```json
"launchRetryPolicy": { "maxRetries": 1, "backoffMs": 1000 }
```

This closed, launch-captured configuration defaults to one retry with a 1,000 ms
deterministic delay. `maxRetries` accepts only 0 or 1; `backoffMs` is an integer
from 0 through 30,000. Zero retries disables recovery. Configuration cannot change
an active run. All generations share the original monotonic phase deadline and
abort signal; the controller checks time before waiting and dispatch. An optional
trusted `authorizeLaunchCost` embedding callback must return `true` for dispatch;
false, missing/indeterminate returns and exceptions deny it. No callback means no
authoritative monetary ceiling exists, **not** that costs are zero.

## Trusted classification, not text matching

The initial classifier is version 1, rule `codex-daybreak-verification-v1`.
`provider-launch.ts` recognizes the exact diagnostic
`Unable to verify Daybreak Blue access. Please try again.` **only** in the pinned
Pi provider-error protocol after successful command completion proves process
exit. It verifies session UUID, provider/model/API, a complete first agent/turn,
empty assistant content, no response identity, zero placeholder usage, matching
terminal copies and no extra events. The bounded stream must have valid UTF-8,
closed JSON objects, no duplicate members and a final newline. Pi's empty
provider placeholder is not model work. The process may have a seeded session
and user input, but must have emitted no model content, tool activity or result.

An ordinary exception, stderr diagnostic, matching model text, failed/uncertain
command transport, authentication error, moderation refusal, timeout,
malformed/partial result, tool/implementation failure, unknown protocol variant
or non-allowlisted infrastructure failure **does not retry**. No broad HTTP or
transport-message guessing is used. Additional service/transport rules need
independent typed termination/activity proof and a reviewed classifier extension.
Clean workspace and exact unchanged HEAD are independently checked before every
launch and after a retryable failure. Neither check alone proves absence of
execution effects. A consumed result or Plan child progress closes eligibility.

Supervised Plan's child operational failures remain terminal; this change does
not restart an aggregate after Requirements or Design activity. The ordinary
single-session phases use the new launch protocol. Legacy embedding phase ports
must explicitly advertise controller-generation support (`launchRetry: true`)
before they can participate; production `SandboxPiPhaseRunner` does so.

## Durable launch ownership and identity

New capable runs have immutable `launchRetryPolicy` and append-only `launches`
fields; legacy schema-version-1 records without them remain readable. Each record
binds phase/attempt, generation, controller UUID, session UUID, canonical input
and session paths, exact input HEAD, logical-input digest, system-prompt digest,
original deadline, timestamp, requested/elapsed delay, transition, sanitized
execution code and optional classifier rule/version/evidence digest. Run,
sandbox, branch, original baseline, profile, feedback and prior results are
bound in the detached deeply frozen logical input. The logical input/system
prompt are unchanged; only generation/session transport identity and its input
pathname change. The runner refuses mismatched session paths.

Generation 1 retains historical paths; generation 2 uses e.g.
`/ticket/sessions/review/1-g2.jsonl` and
`/ticket/artifacts/inputs/review-1-g2.json`. It gets a fresh UUID, never resumes a
failed session and never overwrites failed-generation evidence. Private host
input copies use exclusive creation and are removed after copying/launch.

Transitions are `reserved -> dispatched -> failed | returned`, with `stopped`
for a pre-dispatch denial. `returned` means the handoff boundary was reached,
**not** acceptance or success: existing parsing, evidence, correction, wiki and
exact-HEAD gates still decide that. A second reservation requires the first
failed generation's typed allowlist evidence and available retry allowance.
The JSON store serializes each append using its existing version CAS/update
lock and verifies ticket reservation ownership before publishing. Identity
drift, overwritten evidence, duplicate dispatch, overlapping launches, session
reuse, generation gaps and results from unauthorized generations are rejected.

The reservation is charged before backoff; dispatch is committed before calling
the adapter. A losing writer never launches. **Crash recovery is conservative:**
there is no automatic ownership transfer or resume of a started workflow, even
if a retry was only reserved. Existing `runReserved` refuses a started lifecycle;
new controllers do not steal reservations, replay accepted phases or infer remote
termination from a clean checkout. A persisted dispatch without settled proof is
ambiguous and requires human authorization. Read-only restart/status reconciliation
can expose the ledger but cannot launch it. This deliberately favors safety over
recovering a retry whose owner died during backoff; it is not a general resumable
workflow protocol. Never edit terminal state or delete another owner's lock to
retry a phase.

## Status, events and accounting

`status` distinguishes `retrying-backoff` from `model-work`, showing logical
attempt, generation, retry used/remaining, rule/version, bounded error code and
delay. Watch adds `launch_failed`, `launch_retry_scheduled`,
`launch_retry_started`, `launch_retry_returned` and `launch_retry_stopped`.
Semantic event IDs include generation; reconciliation deduplicates events from
the immutable ledger. No raw provider body, prompt, credential or exception text
is copied into these records/events.

Telemetry emits distinct session rows with additive `launchGeneration` under the
same phase attempt, and the relaunch has trigger `retry`. Inventory uses dispatched
launch identities, rather than assuming one session per attempt. Both the failed
launch and retry retain their own endpoints, outcomes and accounting evidence.
Empty error placeholders are **not** proof of zero billing; incomplete usage/cost
stays incomplete. Recovery adds only the failed gate launch and retry, not another
Plan/Implement. For comparisons, sum those actual rows and preserve incompleteness
rather than inventing an avoided-cost estimate. Historical telemetry without
`launchGeneration` remains readable.

The production-controller/adapter, JSON CAS/crash, negative-classifier, status and
telemetry fixtures are in `test/personal-launch-retry.test.ts`. They run in `npm
test` and the bounded unconditional Windows gate. Existing exact-head hosted CI,
independent Review/Test, publication and merge requirements are unchanged.
