# SQ-02 new native acceptance: operation specification only

**Unexecuted. No runtime authorization or native qualification is claimed.** This is the concrete next operation scope for a later specific execution decision, not an executable admission or a claim that its cleanup precondition is already established. The exact harness command and source hash must be bound after a concrete qualified control implementation exists; none is fabricated here.

## Proposed operation

Run at most two new direct-child correctness cases against the rebuilt Node launcher and execution wrapper, stopping before the second case if the first fails. Use the same declared supported Node24 executable; do not substitute a binary after denial. Each child uses a new admitted job identity and owned temporary directory, an explicit minimal environment (TMPDIR/LANG/TZ), no shell, and stdio `[ignore, ignore, ignore]`. No Node options, input payload, model, credential, network, artifact export or provider is involved.

| Case | Exact inert child program | Requested check |
| --- | --- | --- |
| native-exit7-v1 | `process.exit(7)` | Native exit event retains integer7, with observed monotonic wall time and independent settlement evidence |
| native-abort-v1 | `setTimeout(() => process.exit(0), 250)` | Abort the owned job 20ms after observed spawn; retain latched cancellation, raw observed exit or null/signal, original shutdown deadlines and truthful cleanup |

Only one direct child is live at a time. Neither program imports code or creates descendants. Each job has an explicit one-second task budget, TERM grace50ms, KILL grace50ms and polling interval5ms. The second child self-expires after250ms even if no signal is delivered; this is prearranged fixture behavior, not a denial-triggered fallback. Bound the entire operation to three seconds without a retry. The test must not rely on its own waitpid/group-kill code to declare cleanup qualified.

Before any child launches, independently establish the owned identity/control and bounded cleanup preconditions for this exact environment and command. Unknown preconditions mean do not execute. Do not add escaping, double-forking or daemon fixtures: those need independently qualified containment/cleanup beyond this direct-child proposal. A positive outcome would cover these direct-child launch/exit/abort cases only, not full spawned-descendant custody or hardened isolation.

## Difference from the held diagnostic

These cases target the rebuilt SQ-02 launch, exit and cancellation code. They do not invoke any historical regression script, test helper, stdout/stderr marker payload, audit-file marker, syntax-negative fixture or old source checkout. They neither capture child streams nor investigate the cause of the historical empty-output incident. SQ-05's diagnostic remains held.

The retained historical execution decision also specifically holds new native supervision/identity qualification pending a separate specific decision. Rebuild/source-development permission supports source and deterministic tests; it does not itself establish this proposed operation's host execution authorization or cleanup precondition. The operation therefore remains unexecuted. This is a specific native action limit, not a blanket ban on source work or ordinary owned artifact-file fixtures.

Any actual denial, signal error, unqualified observation, timeout or missing evidence stops the operation and preserves the partial metadata. Do not retry, switch runtime/checkout, change credentials/security/permissions, dispatch alternate cleanup signals or infer CLEAN/DIRTY_LEAK from uncertainty. No automatic campaign follows. The approved UNKNOWN amendment reports unobserved cleanup as failure/cancellation only; it does not authorize this execution or qualify cleanup.

## Exact source successor

Preserve Section2 Step5's full spawned-descendant custody. Select and qualify a concrete ownership/observation/control mechanism that can supply the current group interface truthfully. PGID absence and leader exit alone cannot supply full coverage; numeric token matching alone cannot provide atomic signal safety. No mechanism is selected or claimed sufficient here. Meanwhile SQ-04 depends only on completed SQ-01 and advances as physical local verification source with deterministic file fixtures. SQ-02 remains incomplete.
