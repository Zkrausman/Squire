# Staged model escalation policy

The personal controller supports opt-in user-global `escalationPolicy`, independent
of the unchanged approved `modelPolicy`. Sparse phase keys are plan, implement,
review, test and retro. Closed stage records select provider/model/thinking and
1–16 attempts; each configured phase has 1–8 stages, at most 32 attempts. Model
ordering has no inferred strength, fallback or defaults. Omitted phases retain
legacy one-shot failed-result behavior and existing remediation handling.

`model-policy.ts` validates/detaches schedules and hashes a canonical, domain-
separated digest. Launch material captures configuration; detached handoff checks
state schedule/digest against capture, not mutable config. Baseline deterministic
Plan selection remains persisted; each staged Plan attempt gives both supervised
children the same selected profile with fresh sessions.

`staged-attempts.ts` defines an append-only reservation/closure journal. Reservation
and the global phase counter are persisted together after clean/exact-HEAD
preflight, immediately before invocation. Every reservation consumes one slot,
including open reservations after crashes. No refund, resume or terminal reopening.

Only a validated failed result with matching identity, profile, session and HEAD
can retry. The next slot stays in-stage until its allowance is consumed. For staged advancement, typed
execution errors are closed and terminal: cancellation (interrupted), timeout,
authentication, infrastructure, protocol, unknown. Never infer retry safety or
auth failures from stderr. Supervised Plan operational errors propagate as typed
errors, not retryable failed aggregates; needs_clarification terminates actionably.

Failed Implement may advance the clean committed HEAD without acceptance; other
phases cannot change HEAD. Applicable feedback comes from this run's immediate
prior result, bounded to 20 entries of 2,000 characters. Review/Test remediation
consumes the gate slot but follows the existing Implement/fresh-gate sequence,
not an unchanged gate retry. One Review and one Test remediation remain global;
staged retries never reset those caps. Needed slots are preflighted. Exhaustion
reports phase, digest, stage, consumed/configured counts and trigger, then stops.

State validation preserves immutable schedule/digest and append-only journal
prefixes while accepting legacy v1 records. Status derives the selected profile
and counters from the journal; bounded filesystem watch events expose reservation,
closure, stage advancement and closed reasons. Event reconciliation uses actual
journal outcomes, never infers earlier staged failures as passes.

Credentials, permissions, parser/provenance, project-wiki reconciliation, clean
workspace, exact HEAD, independent Review, fresh Test and Retro gates remain
unchanged. Examples are illustrative only. This is not model ranking, a workflow
graph, provider failover, generic budgeting or failed-run recovery.

See [user contract](../../../docs/staged-escalation.md),
`src/personal/controller.ts`, `src/personal/staged-attempts.ts`, and
`test/personal-escalation-policy.test.ts`.

[Transient launch retry](transient-phase-launch-retry.md) is a separate same-attempt
protocol: one proven empty provider failure may relaunch at the same profile and
exact HEAD, without consuming another staged slot or replaying accepted phases.
It cannot retry model-authored failure, advance a stage, or recover a partial Plan
supervisor. Its launch ledger is independent of the staged reservation/closure
journal, and default retry maximum one can be reduced to zero.
