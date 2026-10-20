# Original-deadline driver — source only

`createManagerDeadlineDriver({session, clock})` drives the existing manager-custody task deadline even while the asynchronous observation bridge has no pending read. It requires an already acknowledged, unquarantined session and an explicitly injected clock with `now()` and `schedule(delay, callback)` returning a cancellation function. It creates no service, bus connection, native timer default, process, watcher or polling loop.

The driver reads the original `task_deadline_ms` from the custody snapshot. There is no new budget, grace default or deadline reset. An early or chunked timer callback checks the monotonic time and rearms against that same absolute deadline. Inline timer callbacks fail closed after capturing their returned cancellation handle. The clock must share the session's monotonic time domain; disagreement cannot manufacture a successful timeout or custody proof. Ports must be bounded and the event loop must progress; this source does not preempt blocked JavaScript or establish host liveness.

Only one driver may own a session at a time within this module. The local WeakSet prevents duplicate drivers; it is not cross-process exclusion, durable host ownership or an admission ledger. The observation bridge may have its own pending read timer concurrently: both delegate deadline handling to the same one-shot StopUnit/cancellation state logic, without additional commands or signals.

## Completion and cancellation

The returned object exposes `result`, `abort()` and `reconcile()`. `result` is a Promise for a frozen `{status, state, runtime_qualification}` snapshot. Status is DEADLINE, CANCELED, RELEASED or FENCED; qualification always remains `NOT_ESTABLISHED_BY_SOURCE`. The driver emits no JobRecord or task-success decision.

At the original deadline, the driver calls `session.tick()`: the core permanently latches timeout cancellation and requests its existing StopUnit branch at most once. It returns the source decision while longer-lived manager custody remains conditional on the acknowledged host guarantees. It does not wait indefinitely for an empty cgroup, stop acknowledgement or native exit, and it does not abandon or qualify host custody by returning. Later host observations may refine the session separately; they cannot rewrite the driver's earlier immutable snapshot.

`abort()` latches user intent before fallible timer/clock cleanup. `reconcile()` lets the caller promptly observe an external abort, quarantine or explicit workspace release without polling. Verified empty alone does not stop the task budget: verification or other work may still be in progress. Only explicit workspace release ends scheduling with RELEASED; UNKNOWN never permits release. If no reconcile is called, the deadline callback still observes the current session state.

Timer/clock failures use the additive `session.schedulingFailed()` entrypoint, latching UNKNOWN and in-memory quarantine with a scheduler classification rather than asserting a manager disconnect. Source callbacks that arrive after completion are ignored. The driver drops its local timer and reservation at completion and does not retain an indefinite background guardian. Cancel-handle errors, reentrant abort and time consumed by cancellation callbacks are reflected in the final source snapshot. There is no retry, fallback signal, reboot release or crash recovery.

## Synthetic validation and remaining scope

Fake tests cover an idle deadline with no observation read, early wakeups, no reset on reconciliation, abort/clock races, verified-empty versus explicit release, disconnect, later immutable custody evidence, scheduling/stop failures, duplicate drivers and coexistence with the observation bridge. The suite launches no native child and performs no bus, service, probe, credential, model or benchmark operation.

This completes source-only deadline scheduling, not an autonomous task runner. Asynchronous StartTransientUnit/StopUnit acknowledgements, real transport/event producers, coordinator integration and host qualification remain incomplete. A pending start cannot be passed off as acknowledged custody. No host guarantee or architecture is expanded, and actual execution remains disabled/unqualified under the existing approval boundary.
