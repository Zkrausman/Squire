# Call reservations, attempts and unknown usage

The source behavior described here is pinned to `50cbf10580670be193d6035763e4c2b9a1a497fa`. The documentation-only reconciliation is recorded at `8e410c01b58d99ce6934ff80af0cb98993d9c8b0`.

**Decision:** report committed Squire call reservations separately from runtime execution, logical attempts and provider-reported usage. Keep conservative accounting: an unavailable or failed result does not establish a refund, zero usage, an elapsed deadline or savings. Existing [corrective admissions](../CORRECTIVE-ADMISSION.md) remain unchanged and require their own authority.

## Source ledger

[produceAgent](../../src/controller.mjs#L300-L344) creates a fresh job ID. One Store transaction checks the call ceiling, inserts a producer-call reservation, increments `agentCalls`, applies the role's `onStarted` callback and emits `job.started`. If that transaction fails, its counter and reservation do not commit. Only after it commits does the controller create physical-job evidence and invoke `runtime.execute`. [reserveCall](../../src/operation-store.mjs#L107-L111) requires the owning producer scope. A successful reservation alone does not show that evidence creation, runtime invocation or provider inference occurred.

| Boundary | Retained or charged by source | Limit |
| --- | --- | --- |
| Preparation, policy or proof fails before reservation | No reservation from an unentered call transaction. Planning and review attempt counters can advance earlier. | Logical counters are not provider-call counts; unrelated earlier jobs remain separate. |
| Reservation commits, then `beginJobEvidence` fails | The debit and role's `onStarted` state precede evidence creation; `execute` has not been reached. Evidence creation is outside the runtime try/catch. | Missing `job.finished` grants neither refund nor completion; existing producer and failure semantics remain. |
| Runtime fails after invocation | Terminal export and `job.finished` are attempted; usage or session metadata may be absent. | Missing usage is not affirmative evidence of zero inference or resource use. Persistence failures retain their existing fences. |
| Runtime returns `waiting_capacity` | A reservation already exists. [Implementation](../../src/controller.mjs#L453-L481) keeps the incremented non-continuation attempt; capacity during repair reverses that path's repair increment. [Review](../../src/controller.mjs#L525-L534) persists `waiting_capacity` with `resumeStatus: review_ready`. | A repair increment being reversed does not mean the call was uncharged. A later physical retry reserves another call. |
| Explicit continuation | Another physical reservation, while the logical attempt keeps its existing count. One-use admission and candidate guards remain. | Preserving a logical attempt does not exempt total calls, review or delivery. |
| Fresh review | `reviewAttempts` advances before criterion proof resolution and the call; entering the review call creates a fresh reservation. | A review-attempt number alone cannot establish dispatch. Old review is not automatically current after a candidate change. |
| Host setup, checks, Git, delivery or acceptance | May register process operations without entering `produceAgent`. | Subprocesses are not extra Squire agent-call reservations merely by running; their resource and owner cost still exists. |

The [Codex adapter](../../src/runtime-codex.mjs#L100-L128) takes usage from parsed `turn.completed` events and can return capacity failure with observed usage and session fields. It does not establish a complete, independently reconciled billing ledger or one reservation per provider turn. Controller callbacks and final events retain reported metadata without proving missing usage is zero or summing every possible internal provider operation. Physical job, CLI process and provider inference or turn are distinct units.

In a symbolic ideal case with owner-supplied tickets, three tickets each needing one implementation and one fresh review require six role reservations. Planning adds its own reservation. More generally, `C = P + I + V` counts committed plan, implementation and review reservations, including jobs that never reach `execute`. Repair, review retry, continuation and rebase-dependent work add their actual role reservations; do not double-count buckets. This is source arithmetic, not a run, quality prediction or promise that six calls suffice for a real outcome.

## Time and negative evidence

Each job receives its configured [timeout and backoff](../../src/controller.mjs#L307-L308); capacity results schedule retry times. This does not create a single absolute whole-project execution deadline across all physical retries and waits. CI has separate deadline, pending and network paths. Counters and retry timestamps are not total elapsed effort or new benchmark time admission; externally frozen benchmark deadlines and holds remain unchanged.

The [capacity fixture](../../test/controller.test.mjs#L144-L155) checks waiting and repair count. It is inspected source, not fresh execution or exhaustive accounting coverage. The source does not establish a fixture for every pre-evidence failure, role or deadline combination. Future separately admitted validation could check reservation rollback, evidence-creation failure after debit, capacity with missing or present usage, continuation versus logical attempt, proof failure before review call, and retry ceilings. No cases are added or run in this note.

No accounting implementation or cap change is selected. Report the unit, retain charged reservations and unknown usage, and preserve ownership and deadline gates before new physical action. This note establishes no execution success, restored capacity, benchmark result or savings benefit.
