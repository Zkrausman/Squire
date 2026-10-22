# FIXOBS asynchronous lifecycle harness

`src/fixobs-port.mjs` is a source-only asynchronous harness around the existing
`createFixobsObservation` model and its finite frame predicates. It exports
`createFixobsLifecycleHarness(options)`, `FIXOBS_HARNESS_ENUMS`, and
`FIXOBS_HARNESS_CONTRACT`.

The factory takes `t0_ms`, a `{run_id, job_id, generation_id}` correlation,
`ports`, `clock`, `scheduler`, and `mode: 'SOURCE_SIMULATION'`. The five injected
ports implement `launch(request)`, `dispatchAction(request)`, `captureFrame(request)`,
`stop(request)`, and `observeSettlement(request)`. Each receives a frozen,
correlated request and returns a promise. `clock.now()` supplies safe,
nonnegative monotonic milliseconds. `scheduler.schedule(target_ms, callback)`
registers a synthetic deadline and returns `{cancel()}`. No wall clock or native
timer is used.

`runLifecycle()` drives one sequential run. `step(phase, at_ms)` advances one
phase; `poll(at_ms)` checks the PR180 model without waiting; `deliverDeadline(at_ms)`
delivers a synthetic deadline and waits for cleanup; `abort(reason, at_ms)` latches
cancellation even while an active port is pending; and `getSnapshot()` returns a
frozen point-in-time snapshot. `COMPLETED` permanently closes dispatch.

Reservations precede active port calls. Actual call counts increment immediately
before invocation and do not refund on throws or late results. The active promise
slot and cleanup promise slot are independent. Abandoned promises stay rejection
trapped; late launch IDs are retained and fenced but never promote a run. Captured
buffers are passed to the unchanged PR180 model and omitted from returned
snapshots and summaries. Public errors, audit details, identifiers, and retained
arrays have finite domains or explicit bounds.

Successful ACK, CAPTURED, and clean settlement records require `error_code` to
be `null` or `NONE`. A contradictory fault code closes that port result; active
faults prevent later active dispatch. A fault-coded Stop ACK marks the Stop row
and harness `FAULT` without claiming direct-child exit, while an independently
valid later scope observation may still be `OBSERVED_CLEAN`. A fault-coded
`OBSERVED_CLEAN` settlement result instead becomes `UNKNOWN` with
`SETTLEMENT_FAULT`. Rejected, thrown, and
malformed active results use their actual injected completion clock reading
before fault classification; a phase cap reached by then takes precedence.
An invalid capture acquisition time also drops its buffer and reconciles its
already sampled completion before clock rejection. If that completion exceeds
the phase or active cap, `PHASE_DEADLINE` keeps the actual first stop and
derived cleanup bound; otherwise `INVALID_CLOCK` stops at the reconciled model
time. No second completion clock reading or candidate evaluation is added.
Pending port rows receive a terminal fault or timeout disposition before the
summary freezes. Subsequent late identity evidence can appear in bounded fresh
snapshots, while the completed summary and its model and time remain unchanged.

A detected active correlation conflict remains the stop disposition if the
completion clock reenters `abort()`. Abort still latches cancellation and fixes
PR180's first stop; with no prior conflict, `CALLER_ABORT` remains the
disposition.

An early synthetic deadline delivery is ignored until its scheduled target.
The phase target is one millisecond after the inclusive PR180 phase or active
limit. Cleanup uses PR180's verified first stop and its derived deadline; no
fallback cleanup window is invented.

Result event times are checked against their operation's dispatch time and
the monotonic completion clock. A capture acquired before an intervening
`poll()` can pass those harness checks yet still be rejected by the unchanged
PR180 model: `acceptCandidate(buffer, acquired, done)` rejects `acquired`
when `poll()` has already advanced its `last_ms` beyond it. The harness reports
that exact `INVALID_CLOCK` model disposition without changing the acquisition
timestamp or claiming a validated frame.

The harness clears its transient response slot after delivery and its copied
capture record's buffer field after validation. A synthetic retaining-thenable
test checks that a retained callback cannot repeat validation. These source
ownership checks do not prove garbage collection or prevent an injected port,
thenable, or promise from retaining its own result.

The synthetic settlement check requires an acknowledged launch ID and a
launch-closed, full-inspection scope whose `scope_id` equals that acknowledged ID
in this simulation. `OBSERVED_CLEAN` also requires zero live entries and no
conflicting identities. A status enum or Stop ACK alone is insufficient.
`direct_child_exit_observed` never proves full settlement. This string matching
is only a simulation consistency check; it provides no process provenance,
confinement, custody, or cleanup proof.

PR180 remains authoritative for reservations, timestamps, frame slots, and model
stop semantics. In particular, `stop(at)` receives only a timestamp, a
pre-validation deadline can leave capture attempts at zero and frame slots
`NOT_RUN`, and an actual port call is still counted before invocation when later
validation fails.

`BUFFER_SEQUENCE_MATCH` means only that supplied canonical buffers satisfied the
finite predicates in the modeled sequence and budget. `SOURCE_SIMULATION` does
not prove native GTK loading, display attribution, physical input delivery,
causality, process ceiling compliance, runtime support, or benchmark success.
Runtime admission, qualified observation, custody, and process-ceiling
enforcement remain false.
