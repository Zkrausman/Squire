---
type: concept
domain: engineering
confidence: high
---

# Transient phase-launch retry

The personal controller can relaunch a single **logical phase attempt** once,
without replaying accepted phases. `launchRetryPolicy` defaults to one retry and
1000 ms deterministic backoff; only 0/1 retries and integer 0–5000 ms delay are
accepted. Raw/effective policy, prompts and config are captured and digest-bound.
No model instruction or arbitrary error text can change eligibility or allowance.

Version-1 `TransientLaunchError` is a trusted adapter signal. Its closed allowlist
covers Daybreak entitlement verification and explicit pre-session transport/service
unavailability. The Codex adapter recognizes the exact Daybreak message with
empty failed-process stdout, or a closed empty/zero-usage Pi error envelope.
Model output, tool activity, result consumption and ambiguity must all be explicitly
false. Unknown/auth/moderation/schema/tool/implementation failures, cancellation,
ambiguous timeout, telemetry warnings and controller/Linear errors fail closed.
Independent clean-workspace/exact-HEAD checks precede retry reservation/dispatch;
backoff cannot extend the original deadline. Composite supervised Plan cannot be
replayed on a child failure because earlier children may already have acted.

`launchTransitions` is an append-only `reserved → dispatched → failed|returned`
ledger with immutable input/launch digests, private original-input reference,
phase/attempt/head, generation/session UUIDs, deadline, bounded sanitized errors,
classifier rule/version and actual delay. `returned` is not acceptance. The JSON
store requires the existing exact reservation, live controller process identity,
unchanged candidate and version CAS; ordinary save cannot append a transition.
Stale concurrent controllers lose before calling Pi. Legacy embedded ports without
owner-checked `transitionLaunch` cannot automatically retry. Artifacts are exclusive-create;
cleanup only deletes temporary inputs actually created by that invocation.

`reconcileReservedLaunch` continues only a reserved generation under already-proved
controller ownership, using the original private input and matching launch material.
It does not refetch Linear/config/prompts, transfer dead-owner reservations, repair
terminal runs, redispatch `dispatched` or infer success from `returned`. Different or
reused process identities and ambiguous crash states require human authorization.
It is not a general CLI resume. Accepted Plan/Implement results and independent
Review/Test/remediation/escalation/publication/exact-head gates remain authoritative.

Status/watch distinguish retry waiting/reservation from model dispatch. Telemetry
keeps separate sessions with `transient-retry` attribution for generation 1; missing
usage/accounting remains incomplete. Accounting publication is outside the retry
classifier and cannot cause another ticket lookup or change workflow outcome.

Authority: `src/personal/launch-retry.ts`, `provider-launch-failure.ts`,
`controller.ts`, `json-run-state.ts`, `pi-phase-runner.ts` and
`test/personal-launch-retry.test.ts`. See [durable telemetry](durable-run-telemetry.md)
and [Windows private artifacts](windows-launch-capture.md). Native Windows gates
on all supported Node matrix versions remain mandatory; shared Linux tests are
not native Windows evidence.
