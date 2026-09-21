---
type: concept
title: Transient phase launch retry
---

# Transient phase launch retry

`launchRetryPolicy` is closed configuration, captured in raw/effective launch material and immutable run state. The default is `{ "maxRetries": 1 }`; the only override is zero. A launch generation is not a remediation or escalation attempt. Earlier accepted phases, candidate HEAD, profile, feedback, previous evidence, sandbox, captured prompt/config digest and original monotonic deadline remain bound across a retry.

`launch-retry.ts` owns the versioned non-model classifier. Only a trusted `LaunchFailure` envelope can authorize consideration of a retry, never ordinary exception text or model JSON. The Pi adapter recognizes the exact Daybreak verification line only from a naturally exited Codex process with empty structured-event stdout. Partial events/results, timeout/cancellation and unknown failures fail closed. Typed pre-session connect-reset and service-unavailable codes are separately enumerated; generic HTTP/error strings are not authority. Pinned Pi JSON event emission is the execution-observation boundary; model-writable session files are not consulted.

The controller independently checks clean workspace and exact HEAD without the failed launch signal, persists a new reservation, waits a deterministic 1000 ms within the original deadline, then rechecks cancellation/workspace/time before dispatch. Failed launch errors retain a sanitized execution category and classifier rule/version, not provider responses. Report correction and phase-result/gate failures are not launch retries. Supervised Plan is conservatively excluded because a child may already have completed; retrying it could replay accepted paid work.

The additive v1 `launchGenerations` ledger records immutable generation/session UUIDs, owner identity, logical input digest, expected HEAD, timestamps, backoff and observed elapsed delay. Transitions are append-only `reserved -> dispatched -> returned|failed`; returned has a result digest but is **not acceptance**. JSON state version CAS, ticket reservation ownership, unique generation slots and exclusive staging creation prevent duplicate dispatch/evidence replacement. A new controller encountering any launch history refuses redispatch and requires human authorization. This deliberately does not reconstruct a monotonic deadline, reclaim a reservation, resume returned work, or resurrect a terminal run after a crash.

Generation-qualified sandbox input/session names preserve failed evidence. Host staging files are removed only if created by that invocation, including collision/error paths; retained report and telemetry evidence uses the existing private native boundaries. Launch events expose only phase, logical attempt, generation and transition. Status distinguishes retry backoff from active model work.

Authority: `src/personal/{launch-retry,controller,json-run-state,pi-phase-runner}.ts`. Contract: `test/personal-launch-retry.test.ts`, paired with `personal-launch-material` in the exact Windows Node 20.17.0/22.9.0/24 gate. Native Windows CI remains required on the published exact head; Linux fixtures and Windows path-unit checks are not substitutes.

Related: [Durable telemetry](durable-run-telemetry.md), [Windows launch capture](windows-launch-capture.md), [Report-only correction](report-only-format-correction.md).
