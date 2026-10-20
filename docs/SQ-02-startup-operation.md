# Conservative startup operation — pure source model

`src/startup-operation.mjs` separates retained startup uncertainty from a bounded caller observation. This implements the independently reviewed conservative source-only contract; it does not enable startup or resolve host custody. The JobSpec/JobRecord wire schemas remain unchanged. The later [source-only adoption slice](SQ-02-startup-adoption.md) consolidates startup and manager internals behind their public compatibility facades.

## Operation owner

`createStartupOperation({spec, policy, clock, task_deadline_ms})` validates a JobSpec and closed policy `{unit_name, task_scope}`. The scope must match the spec and be a canonical absolute non-root path. The clock is explicitly injected `{now}`. At creation the owner derives its original deadline exactly once as `now() + spec.max_wall_clock_sec * 1000`; the supplied deadline must equal that value. All times and budgets must be safe integers. Creation is the request-time anchor; caller waits never reset it.

The returned frozen owner exposes `snapshot()`, `markNotAdmitted(reason)`, `markDispatchAttempted()`, `applyStartAck(event)`, `applyDispatchFailure(reason)`, `abort(reason)` and `tick()`. Events are assertions supplied to this model. No method executes a dispatch callback, manager method, child or teardown. Reasons must be caller-selected nonsecret classification identifiers (letter followed by at most 63 letters/digits/underscores), not raw errors.

Phases are NOT_DISPATCHED, DISPATCH_IN_FLIGHT, ACK_CONFIRMED, UNRESOLVED_FENCED and NOT_ADMITTED. Non-admission is accepted only before any possible dispatch. Dispatch can be marked once, and never after cancellation. Only a matching closed `{binding, custody_acknowledged: true, worker_in_cgroup_before_exec: true}` ACK can bind the nonzero InvocationID. An ACK before dispatch or after NOT_ADMITTED is rejected. Exact duplicate ACKs are idempotent; a conflicting or malformed ACK fences the owner. A fence cannot be cleared by a later ACK. A previously captured epoch remains historical identity after a conflict, with custody acknowledgement revoked.

Abort and the original task deadline permanently latch cancellation. A valid late ACK after caller wait or cancellation can bind identity while retaining that intent. An ACK cannot establish task success, cleanup or workspace reuse. The snapshot has no process allocation, exit, settlement, final-record or legacy coordinator-return field. Feeding this unresolved owner into the legacy lifecycle is unsupported and rejected by its state identity validation.

## Local retention and reservations

A private module-local registry strongly retains owners and reserves job identity, unit name and overlapping scopes. Creation rejects conflicts within this one loaded module instance. A locally asserted NOT_ADMITTED transition releases its undispatched reservation; after possible dispatch or fencing the startup API provides no public release, reset, recovery or discharge operation. The later adoption slice permits target-private coordinated scope release only after canonical empty proof. Caller response completion does not remove the owner. Retention is deliberately in-memory and can consume memory; it is not a background guardian or bounded host cleanup policy.

These reservations cannot prevent other processes, module instances or host tools from accessing a workspace. Process exit/crash loses the registry and its guarantees; it is not an authorized resolution. There is no durable custody, filesystem marker, cross-process admission fence or automatic recovery. No host resolution path is implemented here.

## Passive caller waiter

`createStartupWaiter(operation, {clock: {now, schedule}, caller_wait_ms})` returns `{result, reconcile()}`. It accepts only an owner from this module. The finite positive caller budget is independent of the original task budget. `schedule(delay_ms, callback)` must return a cancellation function. No native clock/timer default is supplied; trusted ports must be bounded and share the owner's monotonic time domain.

The result Promise resolves to `{status, caller_waited_ms, operation_snapshot, runtime_qualification}`. Status is ACK_CONFIRMED, NOT_ADMITTED, UNRESOLVED_FENCED or CALLER_WAIT_EXPIRED. None is a terminal JobRecord. A timer or explicit `reconcile()` checks the original caller deadline; owner events also notify pending waiters. An expired caller budget takes precedence over a late ACK for that waiter. A new waiter may observe the retained owner's later ACK. Old response snapshots remain immutable.

Completion detaches the waiter and cancels its timer only. It does not cancel, settle, release or stop ownership of the underlying operation. Early timer delivery re-arms against the same caller deadline. Inline callbacks, invalid handles, scheduler/cancellation failures or a regressing waiter clock reject the waiter Promise with a fixed error. Caller observation failure does not itself change the owner's operation state. An owner-clock failure separately fences that owner. Cancellation-handle side effects are reflected before response delivery. Callers must consume the result Promise, including rejection.

This remains a cooperatively driven fake-clock model: it cannot preempt blocked ports or a stalled event loop, monitor a real service, or guarantee progress after caller response/process shutdown. Tick evaluation requires an owner event or supplied waiter callback; there is no autonomous task-deadline loop after the last waiter leaves.

## Acceptance boundary

Tests cover the contract's 16 cases and additional identity, invalid transition, duplicate/conflict, local overlap, clock and timer races. They exercise injected event assertions only. The existing suites also use previously authorized owned artifact-file fixtures. No test starts a worker, bus client, systemd service, model or benchmark.

Unsafe/native startup stays disabled. The rejected ExecStartPre candidate and weaker unacknowledged-return proposal are not implemented. A real transport, retained host ownership across failure, live admission, final settlement integration and native qualification remain deferred. Neither a caller response nor a quarantine flag is a custody or cleanup guarantee.
