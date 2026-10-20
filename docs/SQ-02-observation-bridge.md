# Asynchronous custody observations — source-only bridge

`createManagerObservationBridge({session, source, clock, read_timeout_ms})` connects an already acknowledged manager-custody session to one injected asynchronous observation source. It does not create a service, connect to D-Bus, install a watcher, read cgroup files or supply native defaults. The approved conditional custody architecture and all host gates remain unchanged. Tests use Promise-controlled fake events and a simulated clock.

The source exposes `nextEvent({binding, signal})`; the clock exposes bounded `now()` and `schedule(delay, callback)` with a cancel function and asynchronous callbacks. Inline callbacks are rejected and the returned handle is canceled before source use. The same monotonic time domain as the custody session is mandatory. The bridge captures that session's original `task_deadline_ms`; repeated reads never extend it. A positive integer `read_timeout_ms` is explicitly supplied; there is no default. The source and scheduling functions must return promptly and must not block JavaScript. Source cancellation is cooperative; a never-settling source promise cannot be forced to terminate by this adapter.

## Event contract

`readNext()` starts at most one pending read for a session across bridge instances, using an in-memory overlap guard that provides no host exclusivity. Overlap is rejected before a second source call. Events are data-only records with exact fields `{type, value}`:

| Type | Value | Effect |
| --- | --- | --- |
| `cgroup` | Existing `{binding, populated, launch_closed, coverage_complete, exact_live_count}` | Delegates to the custody validator. Only matching, closed/full-coverage populated0 can establish empty. |
| `native_exit` | Existing `{binding, code}` | Retains the observed raw integer or null independently of a clock failure; it proves no cleanup. |
| `manager_disconnected` | `{binding}` | Requires this exact job/unit/InvocationID and latches UNKNOWN/quarantine. |

The request carries the immutable admitted epoch. This correlation is not atomic identity safety, authenticated transport or host qualification. The source remains responsible for producing trusted, current observations for that epoch. The bridge adds no native process enumeration, service-state fallback or exact-count inference. Invalid events are fenced rather than echoed into metadata.

Each read resolves a frozen `{status, state, runtime_qualification}`. `state` is the existing immutable custody snapshot; qualification always remains `NOT_ESTABLISHED_BY_SOURCE`. Status describes observation handling, not task success. The read statuses are OBSERVED, CANCELED, DEADLINE, READ_FAILED and FENCED. No JobRecord, transcript or event payload is retained by the bridge result.

## Budgets, uncertainty and late events

The read timer targets the earlier of its explicit timeout and the original task deadline. An early timer callback rechecks the monotonic clock. At the task deadline, the bridge delegates to `session.tick()`, preserving cancellation and the session's one-shot StopUnit policy. A read timeout before that deadline, a source exception/rejection, malformed event, timer failure or clock regression delegates to `observationFailed()`: UNKNOWN and in-memory quarantine latch without pretending that a manager disconnect was observed. This source decision does not prove that manager custody disappeared or survived.

A successful event cancels its observation timer and aborts only that observation read. Abort of the source read is not native cleanup, a StopUnit substitute or an assertion that the source released all resources. Late fulfillment/rejection after completion is consumed and cannot rewrite state or trigger another read. There is no retry, polling loop, automatic workspace release, fallback signal or restart. A new `readNext()` after failure, bridge cancellation or deadline remains fenced.

`bridge.abort()` latches user cancellation through the existing session before completing a pending read; it does not depend on a successful clock read. The existing acknowledged manager remains responsible under its qualification assumptions. External session quarantine/release is respected when a queued event arrives. Timer-cancellation/source-abort callbacks cannot erase cancellation from the returned snapshot.

This is a one-read-at-a-time adapter, not an autonomous scheduler. When no read is pending it creates no deadline timer; the coordinator must continue driving its existing session deadline, optionally with the separately injected [deadline driver](SQ-02-deadline-driver.md). After this bridge returns at the original deadline it does not keep an indefinite observer alive. Later host-custody observation or reconciliation is separate, and existing UNKNOWN quarantine cannot be cleared automatically. No durable state, crash recovery or bounded native liveness is established.

## Remaining source and runtime work

Asynchronous observation delivery is fake-tested. Asynchronous StartTransientUnit/StopUnit acknowledgements, actual bus serialization/subscriptions, authoritative cgroup observations and an autonomous task coordinator are not implemented. The separate deadline driver supplies source-only scheduling while reads are idle. This bridge deliberately requires already acknowledged custody; a pending service-start response cannot be passed off as an acknowledgement. No new policy for an unacknowledged timed-out start is invented here.

Real execution remains disabled/unqualified. Host lifetime, failed/non-empty retention, workload/coverage, exclusive identity authority, stop behavior and admission fences still require separately authorized qualification. Native children, services, probes, held diagnostics, benchmark/model campaigns and denied operation retries are outside this source-only delivery.
