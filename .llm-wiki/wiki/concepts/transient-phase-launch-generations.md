---
type: concept
domain: engineering
confidence: high
---

# Transient phase launch generations

`launchRetries` defaults to one and accepts only zero/one. Captured launch material
and run state bind it immutably. A physical generation is not a remediation or
staged attempt. Generation 1 retries the same phase/input/profile/sandbox,
original baseline, accepted candidate and original deadline with a fresh session
UUID; accepted earlier phases are never replayed.

The trusted Node process adapter applies exact versioned provider rules only to
an explicitly selected launch channel with normal nonzero exit and no stdout.
The Daybreak Blue entitlement-verification diagnostic is allowlisted. Pinned Pi
JSON activity before model/tool work is part of this trust boundary. Ordinary
exception/report text, partial streams, auth-invalid/moderation, timeout,
cancellation, malformed output and implementation failures cannot authorize a
retry. Supervised Plan additionally needs observed remote guard cleanup and no
validated Requirements; Design failure must not replay Requirements.

`launchJournal` is append-only: reserved → dispatched → returned/failed. Each
transition preserves generation/session/input bindings, baseline/candidate,
original expiry and sanitized error classification. `JsonRunStateStore.save`
serializes revision CAS with reservation-owner checks. Dispatch is persisted
before runner entry; a crash between those operations is intentionally ambiguous.
Failed plus certified transient evidence may reserve one successor; an
undispatched reservation may dispatch once under the same existing owner.
Dispatched/returned without accepted result, lost ownership, immutable input
collision and terminal state cannot authorize a relaunch. There is no general
CLI resume/adopt/repair facility or dead-owner reservation stealing.

Independent clean-tree/exact-HEAD checks precede successor reservation and
dispatch. The fixed 1,000 ms backoff consumes the original timeout. The generation
cap bounds additional launches, without altering staged/remediation budgets or
independent Review/Test/wiki/publication/exact-head gates. `returned` is not an
acceptance assertion.

Private immutable generation inputs remain under the configured staging root;
failed and replacement bytes must never overwrite one another. Linux exclusive
fd-relative creation and native Windows protected ACL/retained-handle validation
are required; cleanup may remove only an input created by that invocation.
Status/watch expose generation, canonical rule, delay and retrying-backoff versus
model-work, not responses or secrets. Telemetry has one row per physical paid
session, preserving unknown usage for failed launches.

Authority: `src/personal/launch-retry.ts`, `controller.ts`, `json-run-state.ts`,
`phase-input.ts`, the process/Plan adapters and `test/personal-launch-retry.test.ts`.
The exact suite is unconditional in Linux tests and Windows Node 20.17/22.9/24
CI; Linux success is not proof of native Windows acceptance.
